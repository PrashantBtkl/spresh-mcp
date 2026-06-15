import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import open from 'open';
import { API_BASE_URL, CREDENTIALS_PATH, TOKEN_EXPIRY_BUFFER_MS } from './config.js';

export interface StoredCredentials {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  client_id?: string;
}

export interface OAuthFlowOptions {
  noBrowser?: boolean;
  callbackPort?: number;
}

export function loadCredentials(): StoredCredentials | null {
  try {
    const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<StoredCredentials>;
    if (
      typeof parsed.access_token === 'string' &&
      (parsed.refresh_token === undefined || typeof parsed.refresh_token === 'string') &&
      (parsed.expires_at === undefined || typeof parsed.expires_at === 'number') &&
      (parsed.client_id === undefined || typeof parsed.client_id === 'string')
    ) {
      return parsed as StoredCredentials;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveCredentials(creds: StoredCredentials): void {
  const dir = path.dirname(CREDENTIALS_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export function deleteCredentials(): boolean {
  try {
    fs.unlinkSync(CREDENTIALS_PATH);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

export function loadEnvCredentials(): StoredCredentials | null {
  const apiKey = process.env.SPRESHAPP_API_KEY;
  if (apiKey) {
    return { access_token: apiKey };
  }

  const accessToken = process.env.SPRESHAPP_ACCESS_TOKEN;
  if (!accessToken) {
    return null;
  }

  const expiresAt = Number(process.env.SPRESHAPP_TOKEN_EXPIRES_AT);
  return {
    access_token: accessToken,
    refresh_token: process.env.SPRESHAPP_REFRESH_TOKEN,
    expires_at: Number.isFinite(expiresAt) ? expiresAt : undefined,
    client_id: process.env.SPRESHAPP_CLIENT_ID,
  };
}

export function isTokenValid(creds: StoredCredentials): boolean {
  if (creds.expires_at === undefined) {
    return true;
  }
  return creds.expires_at - TOKEN_EXPIRY_BUFFER_MS > Date.now();
}

export async function refreshAccessToken(creds: StoredCredentials): Promise<StoredCredentials> {
  if (!creds.refresh_token || !creds.client_id) {
    throw new Error('Saved credentials cannot be refreshed. Run `spreshapp-mcp login`.');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: creds.refresh_token,
    client_id: creds.client_id,
  });

  const res = await fetch(`${API_BASE_URL}/mcp/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const updated: StoredCredentials = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    client_id: creds.client_id,
  };

  saveCredentials(updated);
  return updated;
}

function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest()
    .toString('base64url');
  return { codeVerifier, codeChallenge };
}

function generateState(): string {
  return crypto.randomBytes(16).toString('hex');
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close(() => reject(new Error('Failed to get port')));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function assertCallbackPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid callback port: ${port}`);
  }
}

function hasLocalDisplay(): boolean {
  if (process.platform !== 'linux') {
    return true;
  }
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

export async function runOAuthFlow(options: OAuthFlowOptions = {}): Promise<StoredCredentials> {
  const port = options.callbackPort ?? (await findFreePort());
  assertCallbackPort(port);
  const redirectUri = `http://localhost:${port}`;

  // 1. Dynamic client registration
  const regRes = await fetch(`${API_BASE_URL}/mcp/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'spreshapp-mcp', redirect_uris: [redirectUri] }),
  });

  if (!regRes.ok) {
    throw new Error(`Client registration failed: ${regRes.status}`);
  }

  const { client_id } = (await regRes.json()) as { client_id: string };

  // 2. PKCE + state
  const { codeVerifier, codeChallenge } = generatePKCE();
  const state = generateState();

  // 3. Build authorization URL
  const params = new URLSearchParams({
    response_type: 'code',
    client_id,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });
  const authorizeURL = `${API_BASE_URL}/mcp/oauth/authorize?${params.toString()}`;

  // 4. Start local callback server
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });

  const callbackServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const returnedCode = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<html><body><h2>Login failed.</h2><p>You can close this tab.</p></body></html>');
      rejectCode(new Error(`OAuth error: ${error}`));
      return;
    }

    if (!returnedCode || returnedState !== state) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<html><body><h2>Invalid callback.</h2><p>You can close this tab.</p></body></html>');
      rejectCode(new Error('Invalid OAuth callback'));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      '<html><body style="font-family:sans-serif;text-align:center;margin-top:80px">' +
        '<h2>Login successful!</h2>' +
        '<p>SpreshApp MCP is connected. You can close this tab and return to your terminal.</p>' +
        '</body></html>',
    );
    resolveCode(returnedCode);
  });

  await new Promise<void>((resolve, reject) => {
    callbackServer.listen(port, '127.0.0.1', () => resolve());
    callbackServer.on('error', reject);
  });

  // 5. Open browser, unless the caller is setting up a headless host.
  if (options.noBrowser) {
    process.stderr.write('\nBrowser auto-open disabled.\n');
  } else if (!hasLocalDisplay()) {
    process.stderr.write('\nNo local display detected; skipping browser auto-open.\n');
  } else {
    process.stderr.write(`\nOpening browser to log in with your SpreshApp account...\n`);
    try {
      await open(authorizeURL);
    } catch {
      process.stderr.write('Browser auto-open failed.\n');
    }
  }
  process.stderr.write(`Visit this URL to log in:\n${authorizeURL}\n\n`);
  process.stderr.write(`Waiting for OAuth callback on ${redirectUri} ...\n`);

  // 6. Wait for callback
  let authCode: string;
  try {
    authCode = await codePromise;
  } finally {
    callbackServer.close();
  }

  // 7. Exchange code for tokens
  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    code: authCode,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    client_id,
  });

  const tokenRes = await fetch(`${API_BASE_URL}/mcp/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBody.toString(),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    throw new Error(`Token exchange failed: ${tokenRes.status} ${body}`);
  }

  const tokenData = (await tokenRes.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const creds: StoredCredentials = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_at: Date.now() + tokenData.expires_in * 1000,
    client_id,
  };

  saveCredentials(creds);
  process.stderr.write('Login successful. Credentials saved.\n\n');
  return creds;
}

export async function getOrAuthenticateToken(): Promise<StoredCredentials> {
  const envCredentials = loadEnvCredentials();
  if (envCredentials && isTokenValid(envCredentials)) {
    return envCredentials;
  }

  const stored = loadCredentials();
  if (stored && isTokenValid(stored)) {
    return stored;
  }

  if (stored && stored.refresh_token && stored.client_id) {
    process.stderr.write('Access token expired, refreshing...\n');
    try {
      return await refreshAccessToken(stored);
    } catch {
      process.stderr.write('Token refresh failed, re-authenticating...\n');
    }
  }

  return runOAuthFlow();
}

export async function getTokenForServer(): Promise<StoredCredentials> {
  const envCredentials = loadEnvCredentials();
  if (envCredentials && isTokenValid(envCredentials)) {
    return envCredentials;
  }

  const stored = loadCredentials();
  if (stored && isTokenValid(stored)) {
    return stored;
  }

  if (stored && stored.refresh_token && stored.client_id) {
    process.stderr.write('Access token expired, refreshing...\n');
    return refreshAccessToken(stored);
  }

  throw new Error(
    [
      'SpreshApp MCP is not authenticated.',
      'Run `spreshapp-mcp login` on this machine before starting the MCP server.',
      'For headless setup, create an API key at https://www.spreshapp.com/app/api-access and set SPRESHAPP_API_KEY.',
      'OAuth tokens are still supported with SPRESHAPP_ACCESS_TOKEN and optional SPRESHAPP_REFRESH_TOKEN.',
    ].join('\n'),
  );
}
