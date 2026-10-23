import { loadConfiguration } from '../src/config/loadConfiguration';
import { databaseIdentity, DatabaseConfigurationError } from '../src/db/databaseConfig';

// Configuration report only: no PostgreSQL/provider connection or credential-file inspection/chmod.
try {
  loadConfiguration();
  console.log(JSON.stringify(databaseIdentity(), null, 2));
} catch (error) {
  console.error(error instanceof DatabaseConfigurationError ? error.message : 'Database configuration could not be read. Values are omitted.');
  process.exitCode = 1;
}
