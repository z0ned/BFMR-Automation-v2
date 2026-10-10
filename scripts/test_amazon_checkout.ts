import './loadEnv';
import { createInterface } from 'node:readline/promises';
import { PlaywrightBfmrBrowser } from '../src/adapters/playwrightBrowser';
import { requireReservationAlerts } from '../src/services/reservationAlerts';
import { AMAZON_TEST_PRODUCT, runAmazonCheckoutRehearsal } from '../src/services/amazonCheckoutRehearsal';
import { runLiveTestStartup } from './live_test_startup';

async function main() {
  if (!process.stdin.isTTY) throw new Error('Run this checkout rehearsal from an interactive terminal.');
  requireReservationAlerts();
  const browser = new PlaywrightBfmrBrowser({ headless: false });
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    terminal.close();
    await browser.close();
    process.exit(0);
  };
  const signal = () => { void shutdown(); };
  process.once('SIGINT', signal); process.once('SIGTERM', signal); terminal.on('SIGINT', signal);
  try {
    console.log('[Amazon test] Quantity one; saved default delivery address; stop before Place your order.');
    await runLiveTestStartup(browser);
    const page = await browser.createRetailerTab();
    await page.bringToFront();
    await runAmazonCheckoutRehearsal(page, AMAZON_TEST_PRODUCT, {
      log: message => console.log(`[Amazon test] ${message}`),
      manual: async message => { console.log(`[Amazon test] ${message}`); await terminal.question('Press Enter after completing that step in Chromium: '); },
    });
  } catch (error) {
    console.error(`[Amazon test] PAUSED: ${error instanceof Error ? error.message : 'Checkout rehearsal failed.'}`);
    process.exitCode = 1;
  } finally {
    if (!stopping) await terminal.question('Browser retained for inspection. Press Enter to close it, or Ctrl+C to exit. No order will be placed: ');
    process.removeListener('SIGINT', signal); process.removeListener('SIGTERM', signal);
    terminal.close(); await browser.close();
  }
}

main().catch(() => { console.error('[Amazon test] Stopped. Inspect the terminal/browser before retrying.'); process.exitCode = 1; });
