import './loadEnv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBfmrWorker } from '../src/services/bfmrWorker';
import { runLiveTestStartup } from './live_test_startup';
import { relationalStartupHooks } from '../src/services/relationalStartup';

// Compatibility exports for explicitly invoked historical test tooling.
export { processEmail } from '../src/services/dealEmailWorkflow';
export { runBfmrWorker } from '../src/services/bfmrWorker';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runBfmrWorker({ beforeProcessing: async (browser, runtime, guard) => { await runLiveTestStartup(browser, {
    ...relationalStartupHooks(runtime), beforeMutation: guard,
  }); } }).catch(() => {
    console.error('[BFMR test entrypoint] Stopped; inspect durable workflow and recovery evidence.');
    process.exitCode = 1;
  });
}
