import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';
import { configureEnvironment } from './environment';
import { intakeMode } from '../services/emailProvenance';

/** Read exactly one private configuration file; never read home-directory fallbacks. */
export function loadConfiguration(env: NodeJS.ProcessEnv = process.env): string {
  const mode = intakeMode(env.BFMR_INTAKE_MODE);
  let file = env.BFMR_ENV_FILE || path.resolve(mode === 'testing' ? '.env.testing' : '.env.production');
  if (!env.BFMR_ENV_FILE && mode === 'production' && !fs.existsSync(file)) file = path.resolve('.env');
  if (fs.existsSync(file)) {
    const values = parse(fs.readFileSync(file));
    if (values.BFMR_INTAKE_MODE && values.BFMR_INTAKE_MODE !== mode) {
      throw new Error('The configuration file cannot switch environments. Select the mode in the launching command.');
    }
    for (const [key, value] of Object.entries(values)) env[key] ??= value;
  } else if (env.BFMR_ENV_FILE) {
    throw new Error('The explicitly selected private environment file does not exist.');
  }
  env.BFMR_ENV_FILE = file;
  configureEnvironment(env);
  return file;
}
