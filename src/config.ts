import os from 'node:os';
import path from 'node:path';

export const API_BASE_URL = process.env.SPRESHAPP_API_URL ?? 'https://api.spreshapp.com';

export const CREDENTIALS_PATH = path.join(os.homedir(), '.spreshapp', 'credentials.json');

export const PACKAGE_VERSION = '1.0.3';

export const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
