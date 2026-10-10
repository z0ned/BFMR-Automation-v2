import './loadEnv';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { PlaywrightBfmrBrowser } from '../src/adapters/playwrightBrowser';

const browser = new PlaywrightBfmrBrowser({ headless: false });
const prompt = createInterface({ input: stdin, output: stdout });

try {
  const page = await browser.init();
  await page.goto('https://bfmr.com/deals', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  console.log('\nBFMR sign-in setup');
  console.log('Log in to the intended BFMR account in this Chromium window.');
  console.log('Complete MFA or any access challenge yourself if prompted.');
  console.log('When the page shows you are signed in, return here and press Enter.');
  console.log('This command only saves the browser session; it does not reserve a deal.\n');

  await prompt.question('Press Enter after confirming you are signed in: ');
  console.log('Closing Chromium cleanly so the BFMR session is saved in the dedicated profile.');
} finally {
  prompt.close();
  await browser.close();
}
