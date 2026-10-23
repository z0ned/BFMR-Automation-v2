// Shell bridge: exported configuration only. stdout is captured privately.
import { selectDatabase, DatabaseConfigurationError } from '../src/db/databaseConfig';
import { configureEnvironment, environmentPaths } from '../src/config/environment';
try {
  const database = selectDatabase();
  configureEnvironment();
  const flag = process.argv[2];
  if (flag === '--state-dir') process.stdout.write(environmentPaths().state);
  else if (flag === '--backup-dir') process.stdout.write(environmentPaths().backup);
  else if (flag === '--container') process.stdout.write(process.env.BFMR_POSTGRES_CONTAINER || '');
  else if (!flag) process.stdout.write(database.connectionString);
  else throw new Error('Unsupported private configuration selection.');
} catch (error) {
  console.error(error instanceof DatabaseConfigurationError ? error.message : 'Environment selection failed; inspect private paths/settings.');
  process.exitCode = 1;
}
