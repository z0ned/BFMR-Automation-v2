import { createHash } from 'node:crypto';
import { intakeMode, type IntakeMode } from '../services/emailProvenance';

export class DatabaseConfigurationError extends Error {}
export interface SelectedDatabase {
  mode: IntakeMode;
  variable: 'DATABASE_URL_PRODUCTION' | 'DATABASE_URL_TEST';
  connectionString: string;
}
function targetKey(value: string, variable: string): string {
  try {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.hash ||
        !url.pathname.slice(1) || ['host', 'hostaddr', 'port', 'dbname', 'database', 'service'].some(key => url.searchParams.has(key))) {
      throw new Error();
    }
    const hostname = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase()) ? 'loopback' : url.hostname.toLowerCase();
    return JSON.stringify([hostname, url.port || '5432', decodeURIComponent(url.pathname.slice(1))]);
  } catch {
    throw new DatabaseConfigurationError(`${variable} must be a PostgreSQL URL with an explicit host/database and no target overrides. Connection values are omitted.`);
  }
}
/** One selection contract for every live application/maintenance entrypoint.
 * Never use legacy DATABASE_URL, NODE_ENV, PG* defaults or the opposite mode.
 */
export function selectDatabase(env: NodeJS.ProcessEnv = process.env): SelectedDatabase {
  let mode: IntakeMode;
  try { mode = intakeMode(env.BFMR_INTAKE_MODE); }
  catch { throw new DatabaseConfigurationError('BFMR_INTAKE_MODE must be production or testing.'); }
  const variable = mode === 'production' ? 'DATABASE_URL_PRODUCTION' : 'DATABASE_URL_TEST';
  const connectionString = env[variable]?.trim();
  if (!connectionString) throw new DatabaseConfigurationError(`${variable} is required for ${mode} mode. No database fallback is allowed.`);
  const selectedTarget = targetKey(connectionString, variable);
  const otherVariable = mode === 'production' ? 'DATABASE_URL_TEST' : 'DATABASE_URL_PRODUCTION';
  const other = env[otherVariable]?.trim();
  if (other && targetKey(other, otherVariable) === selectedTarget) {
    throw new DatabaseConfigurationError('Production and testing URLs identify the same database target. Configure separate databases.');
  }
  return { mode, variable, connectionString };
}
/** Safe report binding: credentials are neither returned nor hashed. */
export function databaseIdentity(selected = selectDatabase()) {
  return { mode: selected.mode, variable: selected.variable,
    targetSha256: createHash('sha256').update(targetKey(selected.connectionString, selected.variable)).digest('hex') };
}
