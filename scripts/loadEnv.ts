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

for (const envFile of [...new Set(envFiles)]) {
  if (!fs.existsSync(envFile)) continue;

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
    process.env.GOOGLE_APPLICATION_CREDENTIALS = localCredentials;
  }
}
