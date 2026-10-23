import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectDatabase, databaseIdentity, DatabaseConfigurationError } from '../src/db/databaseConfig';

const configured = { DATABASE_URL_PRODUCTION: 'postgresql://synthetic:p%40ss@db.invalid/production',
  DATABASE_URL_TEST: 'postgresql://synthetic:other@db.invalid/testing' };

test('production default and explicit modes select only the requested database', () => {
  assert.equal(selectDatabase(configured).connectionString, configured.DATABASE_URL_PRODUCTION);
  assert.equal(selectDatabase({ ...configured, BFMR_INTAKE_MODE: 'production' }).variable, 'DATABASE_URL_PRODUCTION');
  assert.equal(selectDatabase({ ...configured, BFMR_INTAKE_MODE: 'testing' }).connectionString, configured.DATABASE_URL_TEST);
});

for (const mode of ['production', 'testing']) test(`${mode} refuses a missing selected URL despite legacy, PG and opposite-mode values`, () => {
  const key = mode === 'production' ? 'DATABASE_URL_PRODUCTION' : 'DATABASE_URL_TEST';
  const env: NodeJS.ProcessEnv = { ...configured, BFMR_INTAKE_MODE: mode,
    DATABASE_URL: 'postgresql://legacy:secret@legacy.invalid/wrong', PGDATABASE: 'wrong', PGHOST: 'wrong.invalid' };
  delete env[key];
  assert.throws(() => selectDatabase(env), error => error instanceof DatabaseConfigurationError && error.message.includes(`${key} is required`));
  env[key] = '   ';
  assert.throws(() => selectDatabase(env), DatabaseConfigurationError);
});

test('NODE_ENV never overrides the explicit intake/database mode', () => {
  assert.equal(selectDatabase({ ...configured, NODE_ENV: 'test' }).mode, 'production');
  assert.equal(selectDatabase({ ...configured, BFMR_INTAKE_MODE: 'testing', NODE_ENV: 'production' }).mode, 'testing');
  assert.throws(() => selectDatabase({ ...configured, BFMR_INTAKE_MODE: 'test' }), /production or testing/);
});

test('same-target URLs are refused even with different credentials or localhost spellings', () => {
  assert.throws(() => selectDatabase({ DATABASE_URL_PRODUCTION: 'postgresql://first:password@localhost/shared',
    DATABASE_URL_TEST: 'postgres://second:different@127.0.0.1:5432/shared' }), /same database target/);
});

test('invalid URLs and target overrides stop without leaking connection details', () => {
  for (const connection of ['not-a-url-private-secret', 'https://private-user:private-secret@host.invalid/private-db',
    'postgresql://private-user:private-secret@host.invalid/', 'postgresql://private-user:private-secret@host.invalid/private-db?host=other.invalid']) {
    assert.throws(() => selectDatabase({ DATABASE_URL_PRODUCTION: connection }), error => {
      assert.ok(error instanceof DatabaseConfigurationError);
      assert.doesNotMatch(error.message, /private-user|private-secret|host.invalid|private-db/);
      return true;
    });
  }
});

test('report identity binds mode and database target while excluding credentials', () => {
  const production = databaseIdentity(selectDatabase(configured));
  const testing = databaseIdentity(selectDatabase({ ...configured, BFMR_INTAKE_MODE: 'testing' }));
  assert.notDeepEqual(production, testing);
  const rotated = databaseIdentity(selectDatabase({ ...configured,
    DATABASE_URL_PRODUCTION: 'postgresql://rotated:password@db.invalid:5432/production' }));
  assert.deepEqual(production, rotated);
  assert.match(production.targetSha256, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(production), /synthetic|p%40ss|db.invalid/);
});
