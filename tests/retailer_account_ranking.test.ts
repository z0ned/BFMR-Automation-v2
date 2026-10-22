import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRelationalFixture } from './helpers/relationalPglite';
import { relationalOrderLedger, validateRelationalRetailerAccount } from '../src/services/relationalOrderLedger';

// All SQL runs in disposable PGlite. No private connection or environment is read.
type Fixture = Awaited<ReturnType<typeof createRelationalFixture>>;
async function fixture(t: TestContext) {
  const f = await createRelationalFixture();
  t.after(() => f.db.close());
  await f.db.validateSchema();
  return f;
}
async function retailer(f: Fixture, name = 'Amazon', url = 'https://www.amazon.com/') {
  return (await f.query<{ id: string }>('INSERT INTO public.retailers(name,primary_url) VALUES($1,$2) RETURNING id', [name, url])).rows[0].id;
}
async function account(f: Fixture, retailerId: string, email: string, rank: number | null) {
  return (await f.query<{ id: string }>(`INSERT INTO public.retailer_accounts(retailer_id,email,retailer_account_ranking,ccv)
    VALUES($1,$2,$3,repeat('0',3)) RETURNING id`, [retailerId, email, rank])).rows[0].id;
}
const sqlError = (code: string) => (error: unknown) => (error as { code?: string }).code === code;
const source = (name: string) => readFile(new URL(`../database/${name}`, import.meta.url), 'utf8');
async function script(f: Fixture, sql: string) {
  try { await f.embedded.exec(sql); } catch (error) { await f.embedded.exec('ROLLBACK'); throw error; }
}

test('selects the lowest integer rank, independently of insertion ID and other retailers', async t => {
  const f = await fixture(t);
  const amazon = await retailer(f);
  await account(f, amazon, 'first@example.invalid', 7);
  const chosen = await account(f, amazon, 'preferred@example.invalid', -2);
  await account(f, amazon, 'third@example.invalid', 0);
  await account(f, await retailer(f, 'Other'), 'other@example.invalid', -2);
  const selected = await validateRelationalRetailerAccount(f.db);
  assert.equal(selected.id, chosen);
  assert.equal(selected.email, 'preferred@example.invalid');
  assert.equal(selected.retailer_account_ranking, -2);
  assert.equal(Object.hasOwn(selected, 'ccv'), false);
  assert.ok(f.statements.filter(sql => /SELECT .*FROM public\.retailer_accounts/s.test(sql)).every(sql => !/ccv|SELECT \*/i.test(sql)));
});

test('missing Amazon retailer stops without selecting another retailer', async t => {
  const f = await fixture(t);
  await account(f, await retailer(f, 'Other'), 'other@example.invalid', 1);
  await assert.rejects(validateRelationalRetailerAccount(f.db), /Amazon retailer is missing/);
});

test('duplicate Amazon retailer stops even when only one duplicate has accounts', async t => {
  const f = await fixture(t);
  await account(f, await retailer(f), 'synthetic@example.invalid', 1);
  await retailer(f);
  await assert.rejects(validateRelationalRetailerAccount(f.db), /retailer is ambiguous/);
});

test('Amazon without linked accounts stops startup', async t => {
  const f = await fixture(t);
  await retailer(f);
  await assert.rejects(validateRelationalRetailerAccount(f.db), /retailer account is missing/);
});

test('changing the preferred account blocks the pinned ledger instead of switching accounts', async t => {
  const f = await fixture(t);
  const amazon = await retailer(f);
  await account(f, amazon, 'original@example.invalid', 1);
  const next = await account(f, amazon, 'next@example.invalid', 2);
  const selected = await validateRelationalRetailerAccount(f.db);
  const pin = { retailerId: selected.retailer_id, retailerAccountId: selected.id, expectedAccountEmail: selected.email };
  const ledger = relationalOrderLedger(f.db, pin);
  assert.deepEqual(await ledger.load(), []);
  await f.query('UPDATE public.retailer_accounts SET retailer_account_ranking=0 WHERE id=$1', [next]);
  await assert.rejects(validateRelationalRetailerAccount(f.db, pin), /identity does not match/);
  await assert.rejects(ledger.load(), /identity does not match/);
  assert.equal((await f.query('SELECT id FROM public.orders')).rows.length, 0);
});

test('ranking is required and unique per retailer; CCV remains required', async t => {
  const f = await fixture(t);
  const amazon = await retailer(f);
  await account(f, amazon, 'first@example.invalid', 1);
  await assert.rejects(account(f, amazon, 'null@example.invalid', null), sqlError('23502'));
  await assert.rejects(account(f, amazon, 'duplicate@example.invalid', 1), sqlError('23505'));
  await account(f, await retailer(f, 'Other'), 'other@example.invalid', 1);
  await assert.rejects(f.query(`INSERT INTO public.retailer_accounts(retailer_id,email,retailer_account_ranking)
    VALUES($1,'missing-code@example.invalid',2)`, [amazon]), sqlError('23502'));
});

test('schema validation rejects nullable, defaulted or nonunique ranking', async t => {
  for (const alteration of [
    'ALTER COLUMN retailer_account_ranking DROP NOT NULL',
    'ALTER COLUMN retailer_account_ranking SET DEFAULT 1',
    'DROP CONSTRAINT retailer_accounts_retailer_ranking_uk',
  ]) {
    const f = await fixture(t);
    await f.query(`ALTER TABLE public.retailer_accounts ${alteration}`);
    await assert.rejects(f.db.validateSchema(), /ranking|retailer_accounts/);
  }
});

test('upgrade leaves existing ranks unassigned and refuses finalization until explicit backfill', async t => {
  const f = await fixture(t);
  const amazon = await retailer(f);
  const a = await account(f, amazon, 'first@example.invalid', 1);
  const b = await account(f, amazon, 'second@example.invalid', 2);
  await f.query('ALTER TABLE public.retailer_accounts DROP COLUMN retailer_account_ranking');
  await script(f, await source('migrations/20261022_retailer_account_ranking_prepare.sql'));
  assert.deepEqual((await f.query('SELECT retailer_account_ranking FROM public.retailer_accounts ORDER BY id')).rows,
    [{ retailer_account_ranking: null }, { retailer_account_ranking: null }]);
  await assert.rejects(f.db.validateSchema(), /retailer_account_ranking/);
  const finalize = await source('migrations/20261022_retailer_account_ranking_finalize.sql');
  await assert.rejects(script(f, finalize), /explicitly assign reviewed ranks/);
  await f.query('UPDATE public.retailer_accounts SET retailer_account_ranking=9 WHERE id=$1', [a]);
  await assert.rejects(script(f, finalize), /explicitly assign reviewed ranks/);
  await f.query('UPDATE public.retailer_accounts SET retailer_account_ranking=-1 WHERE id=$1', [b]);
  await script(f, finalize);
  await f.db.validateSchema();
  assert.equal((await validateRelationalRetailerAccount(f.db)).id, b);
  assert.deepEqual((await f.query('SELECT id,email,retailer_account_ranking FROM public.retailer_accounts ORDER BY id')).rows, [
    { id: a, email: 'first@example.invalid', retailer_account_ranking: 9 },
    { id: b, email: 'second@example.invalid', retailer_account_ranking: -1 },
  ]);
});

test('upgrade finalization rejects an unintended default without changing ranks', async t => {
  const f = await fixture(t);
  const amazon = await retailer(f);
  await account(f, amazon, 'synthetic@example.invalid', 4);
  await f.query('ALTER TABLE public.retailer_accounts ALTER COLUMN retailer_account_ranking DROP NOT NULL');
  await f.query('ALTER TABLE public.retailer_accounts ALTER COLUMN retailer_account_ranking SET DEFAULT 1');
  await assert.rejects(script(f, await source('migrations/20261022_retailer_account_ranking_finalize.sql')), /without a default or generation/);
  assert.equal((await f.query<{ retailer_account_ranking: number }>('SELECT retailer_account_ranking FROM public.retailer_accounts')).rows[0].retailer_account_ranking, 4);
});

// Execute the actual seed SQL, substituting only its requested identity with a
// synthetic email and its psql COPY transport with a parameterized data insert.
// The exact shell program is exercised separately in a clean synthetic env.
// This does NOT emulate psql parsing, COPY transport or native role grants.
async function runSeed(f: Fixture, privateInput?: string) {
  const seed = (await source('seed_amazon_account.psql')).replace(/'[^'\n]*@[^'\n]*'/g, "'initial@example.invalid'");
  const copyLine = seed.split('\n').find(line => line.startsWith('\\copy '));
  assert.ok(copyLine);
  const program = copyLine.match(/FROM PROGRAM '([^']+)' WITH/);
  assert.ok(program);
  const [before, after] = seed.split(copyLine);
  assert.ok(before && after);
  const sqlOnly = (value: string) => value.split('\n').filter(line => !line.startsWith('\\')).join('\n');
  try {
    await f.embedded.exec(sqlOnly(before));
    const env: Record<string, string> = { PATH: '/usr/bin:/bin' };
    if (privateInput !== undefined) env.BFMR_INITIAL_ACCOUNT_CCV = privateInput;
    const result = spawnSync('/bin/sh', ['-c', program[1]], { env, encoding: 'utf8', timeout: 5_000 });
    if (result.error || result.status !== 0) throw new Error('Private seed input rejected');
    assert.match(result.stdout, /^[0-9]{3,4}\n$/);
    await f.embedded.query('INSERT INTO pg_temp.bfmr_initial_account_input(ccv) VALUES($1)', [result.stdout.trimEnd()]);
    await f.embedded.exec(sqlOnly(after));
  } catch (error) { await f.embedded.exec('ROLLBACK'); throw error; }
}

test('seed creates the initial rank-one account, preserves leading zeros and permits exact reruns', async t => {
  const f = await fixture(t);
  await runSeed(f, '000');
  await runSeed(f, '000');
  assert.equal((await validateRelationalRetailerAccount(f.db)).email, 'initial@example.invalid');
  assert.equal((await f.query('SELECT id FROM public.retailers')).rows.length, 1);
  assert.equal((await f.query('SELECT id FROM public.retailer_accounts')).rows.length, 1);
  const validity = await f.query<{ valid: boolean }>("SELECT ccv=repeat('0',3) AND retailer_account_ranking=1 AS valid FROM public.retailer_accounts");
  assert.equal(validity.rows[0].valid, true);
  assert.equal((await f.query("SELECT to_regclass('pg_temp.bfmr_initial_account_input') AS temp")).rows[0].temp, null);
});

test('seed refuses an unfinished ranking upgrade before creating initial records', async t => {
  const f = await fixture(t);
  await f.query('ALTER TABLE public.retailer_accounts ALTER COLUMN retailer_account_ranking DROP NOT NULL');
  await assert.rejects(runSeed(f, '000'), /requires finalized non-null integer ranking/);
  assert.equal((await f.query('SELECT id FROM public.retailers')).rows.length, 0);
  assert.equal((await f.query('SELECT id FROM public.retailer_accounts')).rows.length, 0);
});

test('seed rejects missing or malformed private input atomically', async t => {
  const f = await fixture(t);
  for (const value of [undefined, '', '00', '00000', ' 000', '000\n', 'abc', '$(exit 0)']) {
    await assert.rejects(runSeed(f, value), /Private seed input rejected/);
    assert.equal((await f.query('SELECT id FROM public.retailers')).rows.length, 0);
    assert.equal((await f.query('SELECT id FROM public.retailer_accounts')).rows.length, 0);
  }
  await runSeed(f, '0000');
  assert.equal((await f.query("SELECT length(ccv)=4 AS valid FROM public.retailer_accounts")).rows[0].valid, true);
});

test('seed rejects changed CCV or rank without overwriting the existing account', async t => {
  const f = await fixture(t);
  await runSeed(f, '000');
  await assert.rejects(runSeed(f, '0000'), /conflicts with existing data/);
  await f.query('UPDATE public.retailer_accounts SET retailer_account_ranking=8');
  await assert.rejects(runSeed(f, '000'), /conflicts with existing data/);
  assert.deepEqual((await f.query("SELECT retailer_account_ranking,ccv=repeat('0',3) AS unchanged FROM public.retailer_accounts")).rows,
    [{ retailer_account_ranking: 8, unchanged: true }]);
});

test('seed stops on an occupied rank, conflicting homepage or duplicate retailer', async t => {
  for (const scenario of ['rank', 'homepage', 'duplicate']) {
    const f = await fixture(t);
    const amazon = await retailer(f, 'Amazon', scenario === 'homepage' ? 'https://amazon.com/other' : 'https://www.amazon.com/');
    if (scenario === 'rank') await account(f, amazon, 'existing@example.invalid', 1);
    if (scenario === 'duplicate') await retailer(f);
    const before = (await f.query('SELECT id,retailer_id,email,retailer_account_ranking FROM public.retailer_accounts ORDER BY id')).rows;
    await assert.rejects(runSeed(f, '000'), /conflicts with existing data|differs|ambiguous/);
    assert.deepEqual((await f.query('SELECT id,retailer_id,email,retailer_account_ranking FROM public.retailer_accounts ORDER BY id')).rows, before);
  }
});
