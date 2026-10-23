import type { BusinessQueryable } from './relationalTypes';

// Matches the column grants in the fresh installer. No DDL or grant application.
export const intakeWrites = {
  gmail_intake_state: {
    INSERT: ['account_namespace', 'mailbox', 'subscription', 'topic'],
    UPDATE: ['consumed_cursor', 'history_gap', 'watch_baseline', 'watch_expires_at', 'watch_renewed_at', 'updated_at', 'legacy_source_sha256', 'legacy_import_fingerprint'],
  },
  gmail_intake_runs: { INSERT: ['id', 'account_namespace', 'state'], UPDATE: ['state', 'activated_at', 'stopped_at'] },
  gmail_intake_notifications: {
    INSERT: ['subscription', 'message_id', 'account_namespace', 'run_id', 'payload_sha256', 'history_id', 'rejection', 'state', 'consumed_at'],
    UPDATE: ['state', 'consumed_at'],
  },
  gmail_intake_work: {
    INSERT: ['account_namespace', 'gmail_message_id', 'state', 'payload', 'payload_sha256', 'received_at'],
    UPDATE: ['state', 'payload', 'updated_at'],
  },
} as const;
export async function missingIntakePrivileges(db: BusinessQueryable): Promise<string[]> {
  const requirements: Array<{ relation: string; column: string | null; privilege: string }> = [];
  for (const [table, writes] of Object.entries(intakeWrites)) {
    requirements.push({ relation: `public.${table}`, column: null, privilege: 'SELECT' });
    for (const [privilege, columns] of Object.entries(writes)) for (const column of columns) {
      requirements.push({ relation: `public.${table}`, column, privilege });
    }
  }
  const result = await db.query<{ missing: string }>(`WITH requirements AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(relation text, "column" text, privilege text)
  ) SELECT relation || COALESCE('.' || "column", '') || ':' || privilege AS missing FROM requirements
    LEFT JOIN pg_namespace n ON n.nspname='public'
    LEFT JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=split_part(relation,'.',2)
    WHERE CASE WHEN c.oid IS NULL THEN true
      WHEN "column" IS NULL THEN NOT has_table_privilege(current_user, c.oid, privilege)
      WHEN NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=c.oid AND attname="column" AND NOT attisdropped) THEN true
      ELSE NOT has_column_privilege(current_user, c.oid, "column", privilege) END
    UNION ALL SELECT 'public:USAGE' WHERE NOT has_schema_privilege(current_user,'public','USAGE')
    ORDER BY missing`, [JSON.stringify(requirements)]);
  return result.rows.map(row => row.missing);
}
export class IntakePrivilegeError extends Error {
  constructor(readonly missing: string[]) {
    super(`Required Gmail intake privileges are missing: ${missing.join(', ')}. Review database/runtime_intake_grants.psql separately; no state was repaired.`);
  }
}
export async function assertIntakePrivileges(db: BusinessQueryable): Promise<void> {
  const missing = await missingIntakePrivileges(db);
  if (missing.length) throw new IntakePrivilegeError(missing);
}
