import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { intakeMode } from '../services/emailProvenance';

export const providerKeys = [
  'BFMR_EXPECTED_ACCOUNT', 'BFMR_API_KEY', 'BFMR_API_SECRET', 'GMAIL_ACCOUNT_EMAIL',
  'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN',
  'GOOGLE_PUBSUB_TOPIC', 'GOOGLE_PUBSUB_SUBSCRIPTION', 'GOOGLE_APPLICATION_CREDENTIALS',
  'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'BFMR_CHROMIUM_PID',
  'GMAIL_APP_PASSWORD', 'GMAIL_USER_EMAIL', 'IMAP_USER', 'IMAP_PASSWORD',
  'AMAZON_EXPECTED_ACCOUNT', 'AMAZON_DEFAULT_CARD', 'AMAZON_EXPECTED_CARD_LAST4', 'AMAZON_EXPECTED_DELIVERY_FRAGMENT',
  'AMAZON_ACCOUNT_IDENTITY_CONTRACT_VALIDATED', 'AMAZON_ACCOUNT_IDENTITY_SELECTOR',
  'BFMR_ACCOUNT_PROOF_RESERVE_ID', 'BFMR_AMAZON_POLICY_APPROVED',
  'BFMR_CREATION_TERMS_CONTRACT_VALIDATED', 'BFMR_OPEN_EXPOSURE_CONTRACT_VALIDATED',
  'BFMR_ACCEPT_RECOVERY_BASELINE', 'BFMR_INITIALIZE_GMAIL_QUEUE',
  'BFMR_TRACKER_BROWSER_URL', 'BFMR_TRACKER_URL', 'BFMR_POSTGRES_CONTAINER',
  'BFMR_ACCOUNT_IDENTITY_SELECTOR', 'BFMR_ACCOUNT_RESERVATION_SELECTOR',
] as const;

export function environmentPaths(env: NodeJS.ProcessEnv = process.env) {
  const testing = intakeMode(env.BFMR_INTAKE_MODE) === 'testing';
  const name = testing ? 'bfmr-testing' : 'bfmr';
  const home = env.HOME || os.homedir();
  const state = env.BFMR_STATE_DIR || path.join(home, '.local/state', name);
  return { state, profile: env.CHROMIUM_PROFILE_PATH || path.join(home, '.config', name, 'chromium-profile'),
    heartbeat: env.BFMR_HEARTBEAT_PATH || path.join(state, 'worker-heartbeat.json'),
    backup: env.BFMR_BACKUP_DIR || path.join(home, 'backups', name) };
}

// Resolve existing ancestors too: a symlink must not turn a test path into prod state.
function canonical(value: string): string {
  const absolute = path.resolve(value);
  if (fs.existsSync(absolute)) return fs.realpathSync(absolute);
  const parent = path.dirname(absolute);
  return parent === absolute ? absolute : path.join(canonical(parent), path.basename(absolute));
}
function overlaps(a: string, b: string): boolean {
  const relative = path.relative(a, b);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function configureEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  const mode = intakeMode(env.BFMR_INTAKE_MODE);
  const suffix = mode === 'testing' ? '_TEST' : '_PRODUCTION';
  // Suffixes are selected every time, including supervisor children. Never inherit an
  // unsuffixed production provider credential into testing.
  for (const key of providerKeys) {
    if (env[key + suffix] !== undefined) env[key] = env[key + suffix];
    else if (mode === 'testing') delete env[key];
    if (mode === 'testing' && /ACCOUNT$|EMAIL$|TOKEN$|API_KEY$|API_SECRET$|TOPIC$|SUBSCRIPTION$|CREDENTIALS$|CHAT_ID$/.test(key) && env[key] && env[key + '_PRODUCTION'] &&
        env[key].trim() === env[key + '_PRODUCTION']!.trim()) {
      throw new Error(`Testing requires a separate ${key}_TEST value.`);
    }
  }
  for (const key of ['BFMR_STATE_DIR', 'CHROMIUM_PROFILE_PATH', 'BFMR_HEARTBEAT_PATH', 'BFMR_BACKUP_DIR',
    'BFMR_GMAIL_QUEUE_PATH', 'BFMR_MULTI_DEAL_STATE_PATH', 'BFMR_STARTUP_STATE_PATH',
    'BFMR_POST_RESERVATION_STATE_PATH', 'BFMR_STATUS_SNAPSHOT_PATH', 'BFMR_AMAZON_ORDER_LEDGER_PATH']) {
    if (env[key + suffix]) env[key] = env[key + suffix];
  }
  const selected = environmentPaths(env);
  const oppositeEnv: NodeJS.ProcessEnv = { HOME: env.HOME, BFMR_INTAKE_MODE: mode === 'testing' ? 'production' : 'testing' };
  for (const key of ['BFMR_STATE_DIR', 'CHROMIUM_PROFILE_PATH', 'BFMR_HEARTBEAT_PATH', 'BFMR_BACKUP_DIR']) {
    oppositeEnv[key] = env[key + (mode === 'testing' ? '_PRODUCTION' : '_TEST')];
  }
  const opposite = environmentPaths(oppositeEnv);
  for (const [key, value] of Object.entries(selected)) {
    const target = canonical(value);
    for (const other of Object.values(opposite)) {
      const forbidden = canonical(other);
      if (overlaps(target, forbidden) || overlaps(forbidden, target)) throw new Error(`Environment ${key} path overlaps the other environment.`);
    }
  }
  env.BFMR_STATE_DIR = selected.state;
  env.CHROMIUM_PROFILE_PATH = selected.profile;
  env.BFMR_HEARTBEAT_PATH = selected.heartbeat;
  env.BFMR_BACKUP_DIR = selected.backup;
  const files: Record<string, string> = {
    BFMR_GMAIL_QUEUE_PATH: 'gmail-intake.json', BFMR_MULTI_DEAL_STATE_PATH: 'multi-deal.json',
    BFMR_STARTUP_STATE_PATH: 'startup-reservation.json', BFMR_POST_RESERVATION_STATE_PATH: 'post-reservation.json',
    BFMR_STATUS_SNAPSHOT_PATH: 'bfmr-status.json', BFMR_AMAZON_ORDER_LEDGER_PATH: 'amazon-orders.json',
  };
  for (const [key, file] of Object.entries(files)) {
    const value = env[key] || path.join(selected.state, file);
    if (!overlaps(canonical(selected.state), canonical(value))) throw new Error(`${key} must be within the selected environment state directory.`);
    env[key] = value;
  }
}

/** Live test workers need distinct verified provider identities, beyond a DB name. */
export function assertTestingProviders(env: NodeJS.ProcessEnv = process.env): void {
  if (intakeMode(env.BFMR_INTAKE_MODE) !== 'testing') return;
  for (const key of ['BFMR_EXPECTED_ACCOUNT', 'GMAIL_ACCOUNT_EMAIL', 'AMAZON_EXPECTED_ACCOUNT']) {
    const selected = env[key]?.trim().toLowerCase();
    const production = env[key + '_PRODUCTION']?.trim().toLowerCase();
    if (!selected || !production || selected === production) {
      throw new Error(`Testing requires separate ${key}_TEST and ${key}_PRODUCTION identities.`);
    }
  }
  for (const key of ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_PUBSUB_TOPIC', 'GOOGLE_PUBSUB_SUBSCRIPTION', 'BFMR_API_KEY', 'BFMR_API_SECRET']) {
    if (!env[key]?.trim()) throw new Error(`Testing requires explicit ${key}_TEST; production defaults are unavailable.`);
  }
}
