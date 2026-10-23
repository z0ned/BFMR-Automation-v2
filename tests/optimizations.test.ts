import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { WorkerSupervisor } from '../scripts/supervise_worker';
import { PlaywrightBfmrBrowser } from '../src/adapters/playwrightBrowser';

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

test('database/optimizations.sql contains expected indexes and exposure trigger', () => {
  const sqlFile = path.resolve('database/optimizations.sql');
  assert.ok(fs.existsSync(sqlFile));
  const content = fs.readFileSync(sqlFile, 'utf8');

  assert.ok(content.includes('idx_workflow_evidence_cutover'));
  assert.ok(content.includes('idx_reservations_open_exposure'));
  assert.ok(content.includes('idx_orders_order_id'));
  assert.ok(content.includes('check_max_unreimbursed_exposure'));
  assert.ok(content.includes('trg_enforce_exposure_cap'));
});
