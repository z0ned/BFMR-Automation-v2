import './loadEnv';
import { inspectTrackerApiResponseShape } from '../src/services/bfmrTrackerApi';

try {
  const result = await inspectTrackerApiResponseShape();
  console.log('[My Tracker API diagnostic] Sanitized response structures for documented filter combinations:');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`[My Tracker API diagnostic] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
