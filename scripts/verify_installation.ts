import { loadConfiguration } from '../src/config/loadConfiguration';
import { selectDatabase } from '../src/db/databaseConfig';
import { RelationalDatabase } from '../src/db/relationalDatabase';
import { assertIntakePrivileges } from '../src/db/intakePrivileges';

// Infrastructure acceptance only. Does not enroll accounts, start intake or call providers.
async function main() {
  loadConfiguration();
  const selected = selectDatabase();
  const database = new RelationalDatabase(selected.connectionString, async () => {});
  try {
    await database.validateSchema();
    await database.withTransaction(async tx => {
      await assertIntakePrivileges(tx);
      const result = await tx.query<{ unsafe: boolean }>(`SELECT EXISTS (
        SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls)
      ) OR EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND pg_has_role(current_user, c.relowner, 'USAGE')
      ) OR has_database_privilege(current_user, $1, 'CONNECT') AS unsafe`,
      [selected.mode === 'production' ? 'bfmr_test' : 'bfmr']);
      if (result.rows[0]?.unsafe !== false) throw new Error('Runtime role isolation failed.');
    });
    console.log(`${selected.mode}: installed schema, Gmail grants and database role isolation verified. Worker readiness still requires private account/provider/cutover setup.`);
  } finally { await database.close(); }
}
main().catch(() => { console.error('Installation verification failed. Inspect schema/grants/config privately; workers must stay stopped.'); process.exitCode = 1; });
