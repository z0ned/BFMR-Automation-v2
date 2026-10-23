import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureEnvironment, environmentPaths, assertTestingProviders } from '../src/config/environment';

const syntheticHome = path.join(os.tmpdir(), 'bfmr-environment-synthetic-home');
test('test and production defaults use sibling private roots and separate browser/heartbeat/backup paths', () => {
  const production: NodeJS.ProcessEnv = { HOME: syntheticHome };
  const testing: NodeJS.ProcessEnv = { HOME: syntheticHome, BFMR_INTAKE_MODE: 'testing' };
  configureEnvironment(production); configureEnvironment(testing);
  for (const key of ['BFMR_STATE_DIR', 'CHROMIUM_PROFILE_PATH', 'BFMR_HEARTBEAT_PATH', 'BFMR_BACKUP_DIR',
    'BFMR_STARTUP_STATE_PATH', 'BFMR_GMAIL_QUEUE_PATH', 'BFMR_AMAZON_ORDER_LEDGER_PATH']) {
    assert.notEqual(testing[key], production[key]);
  }
  assert.equal(production.BFMR_STATE_DIR, path.join(syntheticHome, '.local/state/bfmr'));
  assert.equal(testing.BFMR_STATE_DIR, path.join(syntheticHome, '.local/state/bfmr-testing'));
});

test('testing discards unsuffixed production provider settings and selects only explicit test settings', () => {
  const env = { HOME: syntheticHome, BFMR_INTAKE_MODE: 'testing', BFMR_API_KEY: 'production-secret',
    BFMR_API_KEY_TEST: 'test-secret', GMAIL_REFRESH_TOKEN: 'production-token', BFMR_ACCEPT_RECOVERY_BASELINE: 'YES' };
  configureEnvironment(env);
  assert.equal(env.BFMR_API_KEY, 'test-secret');
  assert.equal(env.GMAIL_REFRESH_TOKEN, undefined);
  assert.equal(env.BFMR_ACCEPT_RECOVERY_BASELINE, undefined);
  configureEnvironment(env); // Supervisor child selection is idempotent.
  assert.equal(env.BFMR_API_KEY, 'test-secret');
});

test('equal configured provider identities and cross-environment paths fail closed', () => {
  assert.throws(() => configureEnvironment({ HOME: syntheticHome, BFMR_INTAKE_MODE: 'testing',
    GMAIL_ACCOUNT_EMAIL_TEST: 'same@synthetic.invalid', GMAIL_ACCOUNT_EMAIL_PRODUCTION: 'same@synthetic.invalid' }), /separate/);
  assert.throws(() => configureEnvironment({ HOME: syntheticHome, BFMR_INTAKE_MODE: 'testing',
    BFMR_STATE_DIR: environmentPaths({ HOME: syntheticHome }).state }), /overlaps/);
  assert.throws(() => configureEnvironment({ HOME: syntheticHome, BFMR_INTAKE_MODE: 'testing',
    BFMR_STATE_DIR_TEST: '/private/shared-synthetic', BFMR_STATE_DIR_PRODUCTION: '/private/shared-synthetic' }), /overlaps/);
  assert.throws(() => configureEnvironment({ HOME: syntheticHome, BFMR_INTAKE_MODE: 'testing',
    BFMR_STARTUP_STATE_PATH: '/outside-selected-root/private.json' }), /within/);
});

test('symlinked test roots cannot point into production', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bfmr-isolation-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const production = path.join(home, '.local/state/bfmr');
  fs.mkdirSync(production, { recursive: true });
  fs.symlinkSync(production, path.join(home, '.local/state/bfmr-testing'));
  assert.throws(() => configureEnvironment({ HOME: home, BFMR_INTAKE_MODE: 'testing' }), /overlaps/);
});

test('live testing refuses missing or shared external identities before adapter creation', () => {
  assert.throws(() => assertTestingProviders({ BFMR_INTAKE_MODE: 'testing' }), /separate/);
  const env: NodeJS.ProcessEnv = { BFMR_INTAKE_MODE: 'testing' };
  for (const key of ['BFMR_EXPECTED_ACCOUNT', 'GMAIL_ACCOUNT_EMAIL', 'AMAZON_EXPECTED_ACCOUNT']) {
    env[key] = 'test@synthetic.invalid'; env[key + '_PRODUCTION'] = 'prod@synthetic.invalid';
  }
  for (const key of ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_PUBSUB_TOPIC', 'GOOGLE_PUBSUB_SUBSCRIPTION', 'BFMR_API_KEY', 'BFMR_API_SECRET']) env[key] = 'synthetic';
  assert.doesNotThrow(() => assertTestingProviders(env));
  env.AMAZON_EXPECTED_ACCOUNT = env.AMAZON_EXPECTED_ACCOUNT_PRODUCTION;
  assert.throws(() => assertTestingProviders(env), /AMAZON_EXPECTED_ACCOUNT/);
});

test('testing configuration reads only its selected file and rejects mode changes', async t => {
  const { loadConfiguration } = await import('../src/config/loadConfiguration');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bfmr-config-isolation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'testing.env');
  fs.writeFileSync(file, 'DATABASE_URL_TEST=postgresql://synthetic@db.invalid/bfmr_test\nGMAIL_REFRESH_TOKEN_TEST=test-token\n');
  const env: NodeJS.ProcessEnv = { HOME: root, BFMR_INTAKE_MODE: 'testing', BFMR_ENV_FILE: file,
    GMAIL_REFRESH_TOKEN: 'inherited-production-token' };
  loadConfiguration(env);
  assert.equal(env.GMAIL_REFRESH_TOKEN, 'test-token');
  assert.equal(env.DATABASE_URL_PRODUCTION, undefined);
  fs.writeFileSync(file, 'BFMR_INTAKE_MODE=production\n');
  assert.throws(() => loadConfiguration(env), /cannot switch environments/);
});
