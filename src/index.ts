#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getOrAuthenticateToken } from './auth.js';
import { API_BASE_URL, PACKAGE_VERSION } from './config.js';

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
      return 'Authentication expired. Delete ~/.spreshapp/credentials.json and re-run spreshapp-mcp to log in again.';
    }
  } catch {
    // not JSON, return as-is
  }
  return raw;
}

async function main() {
  const creds = await getOrAuthenticateToken();

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

main().catch((err) => {
  process.stderr.write(`spreshapp-mcp error: ${String(err)}\n`);
  process.exit(1);
});
