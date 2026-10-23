import { databaseIdentity } from '../src/db/databaseConfig';
import { sourceIdentity } from './sourceIdentity';
import './loadEnv';
import { runBfmrWorker } from '../src/services/bfmrWorker';

// LIVE production entrypoint: no temporary test startup reservation. Existing
// provider, account, purchase and cutover gates still apply independently.
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('Usage: npm start');
  console.log('LIVE worker: Gmail watch/StreamingPull and the existing guarded BFMR/Amazon workflow.');
  console.log('Requires reviewed business + operational SQL, private configuration and reconciled intake state.');
  console.log('See docs/GMAIL_PRODUCTION_INTAKE.md before a separately authorized live invocation.');
  console.log('No temporary test startup reservation is created.');
} else if (args.length) {
  console.error('[BFMR worker] Unknown argument. Use --help; no workflow was started.');
  process.exitCode = 2;
} else {
  Promise.resolve().then(() => {
    console.log(`[BFMR worker] Source: ${JSON.stringify(sourceIdentity())}`);
    console.log(`[BFMR worker] Database selection: ${JSON.stringify(databaseIdentity())}`);
    return runBfmrWorker();
  }).catch((err: any) => {
    console.error(`\n[BFMR worker] Startup/Runtime Error: ${err?.message || err}`);
    if (err?.stack) {
      console.error(err.stack);
    }
    console.error('\n[BFMR worker] Stopped. Inspect the durable intake/recovery state and private runtime configuration.\n');
    process.exitCode = 1;
  });
}
