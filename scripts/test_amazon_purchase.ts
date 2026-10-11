import './loadEnv';
import { createInterface } from 'node:readline/promises';
import { PlaywrightBfmrBrowser } from '../src/adapters/playwrightBrowser';
import {
  AMAZON_PURCHASE_TEST_PRODUCT,
  amazonProductAsin,
  ensureAmazonFreeNonPrimeDeliverySelected,
  ensureAmazonGiftSelected,
  readAmazonOrderReview,
  retrieveAmazonOrderId,
  runAmazonCheckoutRehearsal,
  submitAmazonOrderOnce,
} from '../src/services/amazonCheckoutRehearsal';

const TARGET_ASIN = 'B0GTMJF7PV';

function readMaxTotal(args: string[]): number {
  const index = args.indexOf('--max-total');
  const raw = index >= 0 ? args[index + 1] : undefined;
  if (!raw || !/^\d+(?:\.\d{1,2})?$/.test(raw) || Number(raw) <= 0 || Number(raw) > 100) {
    throw new Error('Set a positive USD spending limit no greater than $100 with --max-total <amount>, for example --max-total 100.00.');
  }
  return Math.round(Number(raw) * 100);
}

async function askYesNo(terminal: ReturnType<typeof createInterface>, action: string): Promise<boolean> {
  while (true) {
    const answer = (await terminal.question(`Do you want me to ${action}?`)).trim().toLocaleLowerCase();
    if (answer === 'y') return true;
    if (answer === 'n') return false;
    console.log('Please answer Y or N.');
  }
}

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Run the Amazon purchase test in an interactive terminal.');
  }
  const asin = amazonProductAsin(AMAZON_PURCHASE_TEST_PRODUCT);
  if (asin !== TARGET_ASIN) throw new Error('The configured Amazon purchase-test product failed its ASIN check.');
  const maxTotalCents = readMaxTotal(process.argv.slice(2));
  const browser = new PlaywrightBfmrBrowser({ headless: false });
  const terminal = createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log(`[Amazon purchase test] Target: ${AMAZON_PURCHASE_TEST_PRODUCT}`);
    console.log('[Amazon purchase test] Exactly one unit. No BFMR reservation/startup action will run.');
    console.log(`[Amazon purchase test] Maximum order total: $${(maxTotalCents / 100).toFixed(2)} USD.`);
    const page = await browser.createRetailerTab();
    await page.bringToFront();
    const expectedTitle = await runAmazonCheckoutRehearsal(page, AMAZON_PURCHASE_TEST_PRODUCT, {
      log: message => console.log(`[Amazon purchase test] ${message}`),
      manual: async message => {
        console.log(`[Amazon purchase test] ${message}`);
        if (!await askYesNo(terminal, 'continue after you complete the requested checkout setup in Chromium')) {
          throw new Error('Stopped at your request.');
        }
      },
    });

    await ensureAmazonGiftSelected(page, message => console.log(`[Amazon purchase test] ${message}`));
    await ensureAmazonFreeNonPrimeDeliverySelected(page, message => console.log(`[Amazon purchase test] ${message}`));
    console.log('[Amazon purchase test] Gift selection is verified; checking that secure checkout is stable before asking for purchase confirmation.');

    const review = await readAmazonOrderReview(page, TARGET_ASIN, expectedTitle, {
      requireGift: true,
      requireFreeNonPrimeDelivery: true,
    });
    if (!review) throw new Error('Final order-review evidence disappeared. No order was submitted.');
    if (review.totalCents > maxTotalCents) {
      throw new Error(`Order total $${review.totalUsd.toFixed(2)} exceeds the $${(maxTotalCents / 100).toFixed(2)} USD limit. No order was submitted.`);
    }

    // Amazon can briefly return to the gift editor while checkout updates.
    // Require several consecutive final-review reads before showing the
    // review summary or purchase prompt.
    for (let attempt = 0; attempt < 3; attempt++) {
      const readyReview = await readAmazonOrderReview(page, TARGET_ASIN, expectedTitle, {
        requireGift: true,
        requireFreeNonPrimeDelivery: true,
      });
      if (!readyReview || readyReview.totalCents !== review.totalCents) {
        throw new Error('Secure checkout is not stable after saving gift options; no purchase confirmation was requested.');
      }
      if (attempt < 2) await page.waitForTimeout(500);
    }

    console.log('\nFinal review verified:');
    console.log(`  Product: ${expectedTitle || TARGET_ASIN}`);
    console.log('  Quantity: 1');
    console.log('  Delivery: free, no Prime requirement, selected');
    console.log('  This is a gift: selected');
    console.log(`  Total: $${review.totalUsd.toFixed(2)} USD (limit $${(maxTotalCents / 100).toFixed(2)} USD)`);
    console.log('  Visually confirm in Chromium: free non-Prime delivery is selected, and the saved default address and payment method are correct.');
    const action = `place exactly one ${expectedTitle || TARGET_ASIN} using the selected free non-Prime delivery, gift option, default address, and default payment method for $${review.totalUsd.toFixed(2)} USD`;
    if (!await askYesNo(terminal, action)) {
      console.log('[Amazon purchase test] Stopped at your request; no order was submitted.');
      return;
    }

    console.log('[Amazon purchase test] Rechecking the final order screen before the single permitted submission.');
    const result = await submitAmazonOrderOnce(page, TARGET_ASIN, expectedTitle, process.env.AMAZON_DEFAULT_CARD, { maxTotalCents, confirmedTotalCents: review.totalCents, log: message => console.log(`[Amazon purchase test] ${message}`) });
    if (result === 'PLACED') {
      console.log('[Amazon purchase test] Amazon confirmed the order. Retrieving Order # from Returns and Orders.');
      const orderId = await retrieveAmazonOrderId(page, TARGET_ASIN, expectedTitle, review.totalCents);
      console.log(`[Amazon purchase test] Order #: ${orderId}`);
    } else {
      console.error('[Amazon purchase test] Order submission outcome is uncertain. Do not rerun; inspect Amazon Orders first.');
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(`[Amazon purchase test] STOPPED: ${error instanceof Error ? error.message : 'Unexpected checkout state.'}`);
    process.exitCode = 1;
  } finally {
    console.log('[Amazon purchase test] Chromium will remain open so you can take a screenshot.');
    const closeBrowser = await askYesNo(terminal, 'close Chromium after you finish your screenshot').catch(() => false);
    terminal.close();
    if (closeBrowser) {
      await browser.close();
    } else {
      console.log('[Amazon purchase test] Chromium remains open. Close the window manually when finished.');
    }
  }
}

main().catch(error => {
  console.error(`[Amazon purchase test] STOPPED: ${error instanceof Error ? error.message : 'Unexpected error.'}`);
  process.exitCode = 1;
});
