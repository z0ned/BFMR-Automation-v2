import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfiguration } from '../src/config/loadConfiguration';

const home = process.env.HOME || os.homedir();
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
    if (err.code !== 'EPERM') {
      console.warn(`[Security] Could not harden permissions on ${filePath}: ${err.message}`);
    }
  }
}

const envFile = loadConfiguration();
secureSecretFile(envFile);

// Normalize path separators on Windows to avoid backslash escaping issues
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS.replace(/["']/g, '').trim();

  // If running in a Linux/Docker container but the path is a Windows path (e.g. C:\Users\...)
  if (process.platform !== 'win32') {
    const rawPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const winMatch = /^([a-zA-Z]):[\\/](.*)$/.exec(rawPath);
    if (winMatch && process.env.BFMR_INTAKE_MODE !== 'testing') {
      const drive = winMatch[1].toLowerCase();
      const relativePart = winMatch[2].replace(/\\/g, '/');
      const candidates = [
        `/mnt/${drive}/${relativePart}`,
        `/${drive}/${relativePart}`,
        `/host_mnt/${drive}/${relativePart}`,
        path.resolve(home, '.bfmr', path.basename(relativePart)),
        path.resolve(process.cwd(), path.basename(relativePart)),
      ];
      const matched = candidates.find(c => fs.existsSync(c));
      if (matched) {
        process.env.GOOGLE_APPLICATION_CREDENTIALS = matched;
      }
    }
  }
}

// The BFMR setup stores the service account file outside the repository. Use it
// as Application Default Credentials unless the operator configured another path.
if (process.env.BFMR_INTAKE_MODE !== 'testing' && (!process.env.GOOGLE_APPLICATION_CREDENTIALS || !fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS))) {
  const localCandidates = [
    path.resolve(home, '.bfmr/gcp-credentials.json'),
    path.resolve(process.cwd(), 'gcp-credentials.json'),
  ];
  for (const candidate of localCandidates) {
    if (fs.existsSync(candidate)) {
      secureSecretFile(candidate);
      process.env.GOOGLE_APPLICATION_CREDENTIALS = candidate;
      break;
    }
  }
}

// Validate that GOOGLE_APPLICATION_CREDENTIALS is an actual Service Account key, not an OAuth client secret
if (process.env.GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
  try {
    const raw = JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
    if (raw.installed || raw.web) {
      console.error('\n❌ [Credentials Error] GOOGLE_APPLICATION_CREDENTIALS points to an OAuth Client Secret JSON, NOT a Service Account Key JSON!');
      console.error('Google Cloud Pub/Sub requires a Service Account Key JSON containing "type": "service_account" and "private_key".');
      console.error('\nHow to fix (takes 30 seconds):');
      console.error('1. Go to Google Cloud Console -> IAM & Admin -> Service Accounts');
      console.error('   https://console.cloud.google.com/iam-admin/serviceaccounts');
      console.error('2. Click on: bfmr-appliance-pubsub@bfmr-automation.iam.gserviceaccount.com');
      console.error('3. Click the KEYS tab -> ADD KEY -> Create new key -> JSON -> Create');
      console.error('4. Save that downloaded JSON file as your GOOGLE_APPLICATION_CREDENTIALS file.\n');
    } else if (raw.type === 'service_account' && !raw.private_key) {
      console.error('\n❌ [Credentials Error] The service account key JSON is missing the "private_key" field.\n');
    }
  } catch {
    // Non-fatal parse warning
  }
}
