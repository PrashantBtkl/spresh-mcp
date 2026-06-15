#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  CREDENTIALS_PATH,
  API_BASE_URL,
  PACKAGE_VERSION,
} from './config.js';
import {
  deleteCredentials,
  getTokenForServer,
  isTokenValid,
  loadCredentials,
  loadEnvCredentials,
  refreshAccessToken,
  runOAuthFlow,
} from './auth.js';

type GateError = {
  error?: string;
  reset_at?: string;
};

function humanizeError(raw: string): string {
  try {
    const e = JSON.parse(raw) as GateError;
    if (e.error === 'subscription_required') {
      return (
        'Oops, you are not subscribed to any plan. ' +
        'Start decoding your competitor after subscribing to any plan at https://spreshapp.com/pricing'
      );
    }
    if (e.error === 'quota_exceeded') {
      return `You have reached your daily limit for this feature. Quota resets at ${e.reset_at ?? 'midnight UTC'}.`;
    }
    if (e.error === 'feature_not_available') {
      return 'This feature is not available on your current plan. Visit https://spreshapp.com/pricing to upgrade.';
    }
    if (e.error === 'auth_required') {
      return 'Authentication required. Run `spreshapp-mcp login`, or set SPRESHAPP_API_KEY from https://spreshapp.com/app/api-access.';
    }
  } catch {
    // not JSON, return as-is
  }
  return raw;
}

function printHelp(): void {
  process.stdout.write(`spreshapp-mcp ${PACKAGE_VERSION}

Usage:
  spreshapp-mcp                 Start the MCP stdio server
  spreshapp-mcp login [options] Authenticate and save credentials
  spreshapp-mcp status          Show authentication status
  spreshapp-mcp logout          Delete saved credentials
  spreshapp-mcp --help          Show this help
  spreshapp-mcp --version       Show package version

Options:
  --no-browser                  Print API key setup instructions for headless agents
  --callback-port <port>        Use a fixed localhost OAuth callback port

Environment:
  SPRESHAPP_API_KEY             Use a dashboard API key for headless auth
  SPRESHAPP_ACCESS_TOKEN        Use an OAuth access token instead of saved credentials
  SPRESHAPP_REFRESH_TOKEN       Optional refresh token for OAuth token auth
  SPRESHAPP_API_URL             Override the SpreshApp API base URL
`);
}

function parseCallbackPort(value: string | undefined): number {
  if (!value) {
    throw new Error('--callback-port requires a port number');
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid callback port: ${value}`);
  }
  return port;
}

async function login(args: string[]): Promise<void> {
  let noBrowser = false;
  let callbackPort: number | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--no-browser') {
      noBrowser = true;
      continue;
    }
    if (arg === '--callback-port') {
      callbackPort = parseCallbackPort(args[i + 1]);
      i += 1;
      continue;
    }
    throw new Error(`Unknown login option: ${arg}`);
  }

  if (noBrowser) {
    printHeadlessLoginInstructions();
    return;
  }

  await runOAuthFlow({ noBrowser, callbackPort });
}

function printHeadlessLoginInstructions(): void {
  process.stdout.write(`Headless SpreshApp MCP setup

For agent or remote server environments, use a SpreshApp API key instead of browser OAuth.

User steps:
  1. Open https://spreshapp.com/app/api-access
  2. Create or copy an API key. It starts with sk_sprs_.
  3. Give the key to the agent or add it to the MCP server environment as SPRESHAPP_API_KEY.

Agent setup:
  SPRESHAPP_API_KEY=sk_sprs_... spreshapp-mcp

MCP config example:
  {
    "mcpServers": {
      "spreshapp": {
        "command": "spreshapp-mcp",
        "env": {
          "SPRESHAPP_API_KEY": "sk_sprs_..."
        }
      }
    }
  }

Check setup with:
  spreshapp-mcp status
`);
}

async function status(): Promise<void> {
  if (process.env.SPRESHAPP_API_KEY) {
    process.stdout.write('Authenticated with SPRESHAPP_API_KEY.\n');
    return;
  }

  const envCredentials = loadEnvCredentials();
  if (envCredentials) {
    const state = isTokenValid(envCredentials) ? 'valid' : 'expired';
    process.stdout.write(`Authenticated with SPRESHAPP_ACCESS_TOKEN (${state}).\n`);
    return;
  }

  const stored = loadCredentials();
  if (!stored) {
    process.stdout.write(`Not authenticated. No credentials found at ${CREDENTIALS_PATH}.\n`);
    process.stdout.write('Run `spreshapp-mcp login`, or run `spreshapp-mcp login --no-browser` for API key setup instructions.\n');
    return;
  }

  if (isTokenValid(stored)) {
    process.stdout.write(`Authenticated with saved credentials at ${CREDENTIALS_PATH}.\n`);
    return;
  }

  if (stored.refresh_token && stored.client_id) {
    process.stdout.write('Saved access token is expired; attempting refresh...\n');
    await refreshAccessToken(stored);
    process.stdout.write(`Authenticated with refreshed credentials at ${CREDENTIALS_PATH}.\n`);
    return;
  }

  process.stdout.write(`Saved credentials at ${CREDENTIALS_PATH} are expired and cannot be refreshed.\n`);
  process.stdout.write('Run `spreshapp-mcp login` to authenticate again.\n');
}

function logout(): void {
  const removed = deleteCredentials();
  process.stdout.write(
    removed
      ? `Deleted saved credentials at ${CREDENTIALS_PATH}.\n`
      : `No saved credentials found at ${CREDENTIALS_PATH}.\n`,
  );
}

async function startServer() {
  const creds = await getTokenForServer();

  const backendClient = new Client({ name: 'spreshapp-mcp', version: PACKAGE_VERSION });
  const httpTransport = new StreamableHTTPClientTransport(new URL(`${API_BASE_URL}/mcp`), {
    requestInit: {
      headers: { Authorization: `Bearer ${creds.access_token}` },
    },
  });

  try {
    await backendClient.connect(httpTransport);
  } catch (err) {
    process.stderr.write(`Failed to connect to SpreshApp API: ${String(err)}\n`);
    process.exit(1);
  }

  // Create a local stdio MCP server that forwards tools/list and tools/call to the backend
  const server = new Server(
    { name: 'SpreshApp', version: PACKAGE_VERSION },
    { capabilities: { tools: {} } },
  );

  // Forward tools/list transparently
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    return backendClient.listTools({ cursor: request.params?.cursor });
  });

  // Forward tools/call with subscription/quota error humanization
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await backendClient.callTool({
      name: request.params.name,
      arguments: request.params.arguments ?? {},
    });

    if (result.isError) {
      const contentBlocks = result.content as Array<{ type: string; text?: string }>;
      const rawText = contentBlocks[0]?.text ?? JSON.stringify(result.content);
      return {
        content: [{ type: 'text' as const, text: humanizeError(rawText) }],
        isError: true,
      };
    }

    return result;
  });

  const stdioTransport = new StdioServerTransport();

  const shutdown = () => {
    backendClient.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.connect(stdioTransport);
  process.stderr.write('SpreshApp MCP server running.\n');
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command) {
    await startServer();
    return;
  }

  if (command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    return;
  }

  if (command === '--version' || command === '-v' || command === 'version') {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return;
  }

  if (command === 'login') {
    await login(args);
    return;
  }

  if (command === 'status') {
    await status();
    return;
  }

  if (command === 'logout') {
    logout();
    return;
  }

  throw new Error(`Unknown command: ${command}. Run \`spreshapp-mcp --help\` for usage.`);
}

main().catch((err) => {
  process.stderr.write(`spreshapp-mcp error: ${String(err)}\n`);
  process.exit(1);
});
