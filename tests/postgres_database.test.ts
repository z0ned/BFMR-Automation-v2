import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { PostgresDatabase } from '../src/db/postgresDatabase';

const url = process.env.BFMR_TEST_DATABASE_URL;
test('PostgreSQL persists commits across restart, rolls back failures, and excludes another process', { skip: !url }, async () => {
  const account = `synthetic-${randomUUID()}`;
  const key = `bfmr_worker_lock_${account}`;
  const db = new PostgresDatabase(url!, account);
  let restarted: PostgresDatabase | undefined;
  try {
    await db.initialize(); assert.equal(await db.claimAccount(key), true);
    await db.withTransaction(async tx => { tx.setGate('durable', 'synthetic evidence'); });
    await assert.rejects(db.withTransaction(async tx => { tx.clearGate('durable'); tx.setGate('rolled-back', 'test'); throw new Error('test rollback'); }), /test rollback/);
    const child = `import pg from 'pg'; const pool = new pg.Pool({connectionString:process.env.BFMR_TEST_DATABASE_URL}); const c = await pool.connect(); const r = await c.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',[process.argv[1]]); console.log(r.rows[0].acquired); c.release(); await pool.end();`;
    const blocked = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', child, key], { env: process.env, cwd: process.cwd() });
    assert.equal(blocked.stdout.trim(), 'false');
    await db.close();
    restarted = new PostgresDatabase(url!, account); await restarted.initialize();
    assert.equal(await restarted.claimAccount(key), true);
    assert.deepEqual(restarted.getRuntimeGates().map(row => row.gate_name), ['durable']);
    await restarted.withTransaction(async tx => { tx.setGate('after-restart', 'test'); });
    assert.equal(restarted.getRuntimeGates().length, 2);
    const loss = new Promise<void>(resolve => restarted!.onOwnershipLost(resolve));
    const admin = new Pool({ connectionString: url });
    try {
      const terminated = await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE application_name=$1 AND pid IN (SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted)`, [`bfmr:${account}`]);
      assert.equal(terminated.rowCount, 1);
      await Promise.race([loss, new Promise((_, reject) => { const timeout = setTimeout(() => reject(new Error('ownership loss was not detected')), 2000); timeout.unref(); })]);
      await assert.rejects(restarted.verifyOwnership(), /ownership/);
      let invoked = false;
      await assert.rejects(restarted.withTransaction(async () => { invoked = true; }), /ownership/);
      assert.equal(invoked, false);
    } finally { await admin.end(); }

  } finally {
    await restarted?.close(); await db.close();
    const pool = new Pool({ connectionString: url });
    try { await pool.query('DELETE FROM bfmr_runtime_state WHERE account_namespace=$1', [account]); }
    finally { await pool.end(); }
  }
});
