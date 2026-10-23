import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { parseArgs, computeFileSha256 } from '../scripts/run_production_cutover';
import { prepareFreshStartCutover } from '../src/services/freshStartCutoverPreparation';
import { parseRelationalCutoverManifest } from '../src/services/relationalCutover';

test('cutover CLI parses arguments correctly', () => {
  const args1 = ['--account', 'my_account', '--dry-run', '--skip-backup'];
  const opts1 = parseArgs(args1);
  assert.equal(opts1.account, 'my_account');
  assert.equal(opts1.dryRun, true);
  assert.equal(opts1.skipBackup, true);
  assert.equal(opts1.nonInteractive, undefined);

  const args2 = ['--report', '--yes', '--dir', '/custom/state'];
  const opts2 = parseArgs(args2);
  assert.equal(opts2.dryRun, true);
  assert.equal(opts2.nonInteractive, true);
  assert.equal(opts2.stateDir, '/custom/state');
});

test('computeFileSha256 calculates accurate SHA-256 hash', () => {
  const tmpFile = path.join(os.tmpdir(), `test-sha-${Date.now()}.txt`);
  const content = 'BFMR Production Cutover Test Content';
  fs.writeFileSync(tmpFile, content, 'utf-8');

  try {
    const expected = crypto.createHash('sha256').update(content).digest('hex');
    const actual = computeFileSha256(tmpFile);
    assert.equal(actual, expected);
    assert.match(actual, /^[a-f0-9]{64}$/);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('prepareFreshStartCutover generates compliant version 2 fresh-start manifest', async () => {
  const tmpDir = path.join(os.tmpdir(), `test-fresh-start-${Date.now()}`);
  await fs.promises.mkdir(tmpDir, { recursive: true });

  try {
    const candidate = await prepareFreshStartCutover({
      account: 'test_operator_account',
      confirmedNoOutstandingWork: true,
      directory: tmpDir,
    });

    assert.ok(fs.existsSync(candidate.manifestPath));
    const manifest = candidate.manifest;
    assert.equal(manifest.version, 2);
    assert.equal(manifest.account, 'test_operator_account');
    assert.equal(manifest.baseline?.mode, 'START_FROM');
    assert.equal(manifest.baseline?.priorCompletedActivity, 'EXCLUDED');
    assert.equal(manifest.baseline?.noOutstandingWork, true);
    assert.equal(manifest.reservations.length, 0);
    assert.equal(manifest.legacyOrderLedgerSha256, null);

    // Verify it passes relationalCutover manifest validation
    const parsed = parseRelationalCutoverManifest(manifest);
    assert.equal(parsed.version, 2);

    // Verify idempotency on second call
    const second = await prepareFreshStartCutover({
      account: 'test_operator_account',
      confirmedNoOutstandingWork: true,
      directory: tmpDir,
    });
    assert.equal(second.manifestPath, candidate.manifestPath);
    assert.equal(second.manifest.baseline?.startsAt, manifest.baseline?.startsAt);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});

test('prepareFreshStartCutover rejects missing no-outstanding-work confirmation', async () => {
  const tmpDir = path.join(os.tmpdir(), `test-fresh-start-fail-${Date.now()}`);
  await fs.promises.mkdir(tmpDir, { recursive: true });

  try {
    await assert.rejects(
      async () => {
        await prepareFreshStartCutover({
          account: 'test_operator_account',
          confirmedNoOutstandingWork: false,
          directory: tmpDir,
        });
      },
      /no-outstanding-work confirmation/
    );
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});
