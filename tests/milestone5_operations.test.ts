import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WorkerSupervisor, getDefaultSupervisorConfig } from '../scripts/supervise_worker';
import { checkSystemHealth } from '../scripts/health_check';

test('WorkerSupervisor writes structured heartbeat file', () => {
  const tmpHeartbeat = path.join(os.tmpdir(), `test-heartbeat-${Date.now()}.json`);
  const config = {
    ...getDefaultSupervisorConfig(),
    heartbeatPath: tmpHeartbeat,
  };

  const supervisor = new WorkerSupervisor(config);
  supervisor.writeHeartbeat('RUNNING');

  assert.ok(fs.existsSync(tmpHeartbeat));
  const content = JSON.parse(fs.readFileSync(tmpHeartbeat, 'utf-8'));
  assert.equal(content.status, 'RUNNING');
  assert.equal(content.totalRestarts, 0);
  assert.ok(content.timestamp);

  supervisor.writeHeartbeat('DEGRADED', 'Test error condition');
  const degradedContent = JSON.parse(fs.readFileSync(tmpHeartbeat, 'utf-8'));
  assert.equal(degradedContent.status, 'DEGRADED');
  assert.equal(degradedContent.error, 'Test error condition');

  fs.unlinkSync(tmpHeartbeat);
});

test('checkSystemHealth detects stale heartbeat and degraded worker state', async () => {
  const tmpHeartbeat = path.join(os.tmpdir(), `test-health-${Date.now()}.json`);
  process.env.BFMR_HEARTBEAT_PATH = tmpHeartbeat;

  try {
    // Write stale heartbeat (3 minutes ago)
    const staleDate = new Date(Date.now() - 180000).toISOString();
    fs.writeFileSync(tmpHeartbeat, JSON.stringify({
      pid: 12345,
      supervisorPid: 12340,
      status: 'RUNNING',
      timestamp: staleDate,
      totalRestarts: 0,
      error: null,
    }));

    const health = await checkSystemHealth();
    assert.equal(health.worker, 'DEGRADED');
    assert.ok(health.details.issues.some(i => i.includes('stale')));
  } finally {
    if (fs.existsSync(tmpHeartbeat)) fs.unlinkSync(tmpHeartbeat);
    delete process.env.BFMR_HEARTBEAT_PATH;
  }
});

test('checkSystemHealth detects active healthy heartbeat', async () => {
  const tmpHeartbeat = path.join(os.tmpdir(), `test-health-fresh-${Date.now()}.json`);
  process.env.BFMR_HEARTBEAT_PATH = tmpHeartbeat;

  try {
    fs.writeFileSync(tmpHeartbeat, JSON.stringify({
      pid: 54321,
      supervisorPid: 54320,
      status: 'RUNNING',
      timestamp: new Date().toISOString(),
      totalRestarts: 0,
      error: null,
    }));

    const health = await checkSystemHealth();
    assert.equal(health.worker, 'RUNNING');
    assert.equal(health.details.workerPid, 54321);
  } finally {
    if (fs.existsSync(tmpHeartbeat)) fs.unlinkSync(tmpHeartbeat);
    delete process.env.BFMR_HEARTBEAT_PATH;
  }
});
