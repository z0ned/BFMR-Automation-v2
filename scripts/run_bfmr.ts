import './loadEnv';
import { runBfmrWorker } from './test_real_email_e2e';

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
  runBfmrWorker().catch(() => {
    console.error('[BFMR worker] Stopped. Inspect the durable intake/recovery state and private runtime configuration.');
    process.exitCode = 1;
  });
}
