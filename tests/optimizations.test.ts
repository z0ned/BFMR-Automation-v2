import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WorkerSupervisor } from '../scripts/supervise_worker';
import { PlaywrightBfmrBrowser } from '../src/adapters/playwrightBrowser';
import { secureSecretFile } from '../scripts/loadEnv';
import { RelationalDatabase } from '../src/db/relationalDatabase';

test('WorkerSupervisor.reapOrphanBrowserProcesses executes safely', () => {
  assert.doesNotThrow(() => {
    WorkerSupervisor.reapOrphanBrowserProcesses();
  });
});

test('PlaywrightBfmrBrowser provides captureErrorScreenshot method', async () => {
  const browser = new PlaywrightBfmrBrowser();
  assert.equal(typeof browser.captureErrorScreenshot, 'function');

  // When uninitialized, returns null cleanly without throwing
  const result = await browser.captureErrorScreenshot('test_label');
  assert.equal(result, null);
});

test('database/optimizations.sql contains expected indexes, exposure trigger, and CCV drop', () => {
  const sqlFile = path.resolve('database/optimizations.sql');
  assert.ok(fs.existsSync(sqlFile));
  const content = fs.readFileSync(sqlFile, 'utf8');

  assert.ok(content.includes('idx_workflow_evidence_cutover'));
  assert.ok(content.includes('idx_reservations_open_exposure'));
  assert.ok(content.includes('idx_orders_order_id'));
  assert.ok(content.includes('check_max_unreimbursed_exposure'));
  assert.ok(content.includes('trg_enforce_exposure_cap'));
  assert.ok(content.includes('DROP COLUMN IF EXISTS ccv'));
});

test('secureSecretFile hardens broad file permissions to 0600 on POSIX systems', () => {
  const tmpFile = path.join(os.tmpdir(), `test-secret-${Date.now()}.env`);
  fs.writeFileSync(tmpFile, 'SECRET_KEY=test', { mode: 0o666 });

  try {
    secureSecretFile(tmpFile);
    if (process.platform !== 'win32') {
      const stats = fs.statSync(tmpFile);
      // Mode on POSIX should be 0600 (read/write only by owner)
      assert.equal(stats.mode & 0o777, 0o600);
    }
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('RelationalDatabase provides native claimAccount and verifyOwnership methods', () => {
  assert.equal(typeof RelationalDatabase.prototype.claimAccount, 'function');
  assert.equal(typeof RelationalDatabase.prototype.verifyOwnership, 'function');
  assert.equal(typeof RelationalDatabase.prototype.relinquishAccount, 'function');
});
