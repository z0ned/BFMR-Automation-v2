import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = process.env.HOME || os.homedir();
const configuredEnvFile = process.env.BFMR_ENV_FILE;
const envFiles = [
  configuredEnvFile,
  path.resolve(process.cwd(), '.env'),
  path.resolve(home, '.env.bfmr_automation'),
  path.resolve(home, '.env'),
].filter((file): file is string => Boolean(file));

/**
 * Verifies and enforces secure POSIX permissions (0600) on sensitive credential and environment files.
 * On Windows systems, POSIX mode bits do not apply, so this check runs on Linux/macOS.
 */
export function secureSecretFile(filePath: string): void {
  if (process.platform === 'win32' || !fs.existsSync(filePath)) return;
  try {
    const stats = fs.statSync(filePath);
    // Check if group or others have any read/write/execute permissions (0o077)
    const broadPermissions = stats.mode & 0o077;
    if (broadPermissions !== 0) {
      console.warn(`[Security] Warning: ${filePath} has broad permissions (${(stats.mode & 0o777).toString(8)}). Hardening to 0600...`);
      fs.chmodSync(filePath, 0o600);
    }
  } catch (err: any) {
    console.warn(`[Security] Could not harden permissions on ${filePath}: ${err.message}`);
  }
}

for (const envFile of [...new Set(envFiles)]) {
  if (!fs.existsSync(envFile)) continue;

  secureSecretFile(envFile);

  try {
    // Existing shell values win; later files only fill in unset variables.
    process.loadEnvFile(envFile);
  } catch (error) {
    console.warn(`[Config] Could not load ${envFile}: ${(error as Error).message}`);
  }
}

// The BFMR setup stores the service account file outside the repository. Use it
// as Application Default Credentials unless the operator configured another path.
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  const localCredentials = path.resolve(home, '.bfmr/gcp-credentials.json');
  if (fs.existsSync(localCredentials)) {
    secureSecretFile(localCredentials);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = localCredentials;
  }
}
