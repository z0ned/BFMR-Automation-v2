import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

for (const scenario of ['success', 'existing', 'dump-failure', 'restore-failure']) {
  test(`database clone ${scenario} preserves source and refuses destructive retries`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bfmr-clone-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const log = path.join(root, 'calls');
    const executable = (name: string, content: string) => fs.writeFileSync(path.join(root, name), '#!/bin/bash\nset -eu\n' + content, { mode: 0o700 });
    executable('docker', 'test "$1" = exec; shift\ntest "$1" = -i; shift\ntest "$1" = --user; shift\ntest "$1" = postgres; shift\ntest "$1" = bfmr-postgres; shift\nexec "$@"\n');
    executable('psql', `printf 'psql %s\\n' "$*" >> "$CLONE_TEST_LOG"
case "$*" in *'SELECT count(*)'*) if [ "$SCENARIO" = existing ]; then echo 1; else echo 0; fi ;; esac
`);
    executable('pg_dump', `echo dump >> "$CLONE_TEST_LOG"
if [ "$SCENARIO" = dump-failure ]; then exit 1; fi
for arg in "$@"; do case "$arg" in --file=*) printf 'synthetic snapshot' > "\${arg#--file=}";; esac; done
`);
    executable('pg_restore', `printf 'restore %s\\n' "$*" >> "$CLONE_TEST_LOG"
if [ "$SCENARIO" = restore-failure ]; then exit 1; fi
`);
    const result = spawnSync('bash', ['scripts/clone_test_database.sh'], { encoding: 'utf8', env: {
      PATH: `${root}:/usr/bin:/bin`, HOME: root, CLONE_TEST_LOG: log, SCENARIO: scenario,
    } });
    const calls = fs.readFileSync(log, 'utf8');
    assert.doesNotMatch(calls, /DROP|TRUNCATE|pg_terminate_backend|ALTER DATABASE bfmr /);
    if (scenario === 'success') {
      assert.equal(result.status, 0, result.stderr);
      assert.match(calls, /CREATE DATABASE bfmr_test TEMPLATE template0 CONNECTION LIMIT 0/);
      assert.match(calls, /REVOKE ALL ON DATABASE bfmr_test FROM PUBLIC/);
      assert.match(calls, /restore --dbname=bfmr_test --single-transaction --exit-on-error --no-owner --no-acl/);
      assert.match(result.stdout, /Created bfmr_test/);
    } else {
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stdout, /Created bfmr_test/);
      if (scenario === 'existing') assert.doesNotMatch(calls, /dump|CREATE DATABASE|restore/);
      if (scenario === 'dump-failure') assert.doesNotMatch(calls, /CREATE DATABASE|restore/);
      if (scenario === 'restore-failure') assert.match(result.stderr, /Keep it offline/);
    }
  });
}
