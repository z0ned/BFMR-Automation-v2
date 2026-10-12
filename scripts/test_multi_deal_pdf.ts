import './loadEnv';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { PlaywrightBfmrBrowser } from '../src/adapters/playwrightBrowser';
import { parseBfmrEmail } from '../src/services/bfmrEmailLinks';
import { isTrustedBfmrDealUrl } from '../src/services/bfmrUrl';
import { requireReservationAlerts, withReservationFailureAlert } from '../src/services/reservationAlerts';
import { runLiveTestStartup } from './live_test_startup';
import { processEmail } from './test_real_email_e2e';

const run = promisify(execFile);
const samplePdf = path.resolve('docs/sample_emails/from_bfmr/all_open_deals/EWg0AbZkhJSByrkm4ofOtMDzM6QAJVQ3r3wAA.pdf');
const allowedSenders = new Set(['deals@buyformeretail.com', 'matt.ward@live.com']);

function help(): never {
  console.log('Usage: npm run test-multi-deal-pdf -- [PDF path] [--live]');
  console.log('Without --live: extract and validate the deals; no BFMR or Amazon actions.');
  console.log('With --live: run the existing startup reservation, then reserve/evaluate/order the PDF deals. This has real account effects.');
  process.exit(0);
}

async function readPdfEmail(pdfPath: string) {
  const [bytes, textResult, xmlResult] = await Promise.all([
    readFile(pdfPath),
    run('pdftotext', ['-layout', pdfPath, '-'], { maxBuffer: 2_000_000 }),
    run('pdftohtml', ['-xml', '-stdout', '-hidden', '-i', pdfPath], { maxBuffer: 4_000_000 }),
  ]);
  const plain = textResult.stdout;
  const xml = xmlResult.stdout;
  const subject = plain.match(/^\s*Outlook\s*\n\s*(.+?)\s*$/m)?.[1];
  const sender = plain.match(/^\s*From\s+(.+?)\s*$/m)?.[1];
  const address = sender?.match(/<\s*([^>\s]+)\s*>/)?.[1]?.toLowerCase();
  const announcement = plain.match(/\bWe posted (two|three|four|five|six|seven|eight|nine|ten|\d+) new deals?!/i)?.[0];
  if (!subject || !sender || !address || !allowedSenders.has(address)) {
    throw new Error('PDF lacks a supported sender or subject.');
  }

  const bullets = [...plain.matchAll(/^\s*•\s+([\s\S]*?)(?=^\s*•\s+|^\s*Thank You!)/gm)]
    .map((match) => match[1].replace(/\s+/g, ' ').trim());
  const urls = [...xml.matchAll(/<a\s+href="([^"]+)"/gi)]
    .map((match) => match[1].replace(/&amp;/g, '&'))
    .filter(isTrustedBfmrDealUrl);
  const distinctUrls = [...new Map(urls.map((url) => [new URL(url).pathname.toLowerCase(), url])).values()];
  if (!announcement) {
    const parsed = parseBfmrEmail({ messageId: 'pdf-preview', sender, subject, body: `${plain}\n${xml}` });
    if (parsed.isSingleDeal || parsed.isMultiDealAnnouncement) {
      throw new Error('PDF classification is inconsistent: shared intake accepted an announcement the PDF extractor did not find.');
    }
    return { status: 'SKIPPED' as const, sender, subject, dealLinkCount: distinctUrls.length };
  }
  if (!bullets.length || bullets.length !== distinctUrls.length) {
    throw new Error(`PDF has ${bullets.length} product bullets and ${distinctUrls.length} distinct trusted deal links; refusing to guess a mapping.`);
  }

  const rows = bullets.map((bullet, index) => {
    const details = bullet.match(/^(.+?)\s+-\s+This retails for \$([\d,.]+), we are paying \$([\d,.]+)\./i);
    if (!details) throw new Error(`PDF product bullet ${index + 1} has no unambiguous title, retail price, and payout.`);
    return { title: details[1], retail: details[2], payout: details[3], url: distinctUrls[index] };
  });
  // Rebuild only the observed announcement and matching product links. Footer links,
  // Outlook chrome, and any instructions printed in the PDF remain inert data.
  const body = `${announcement}\n${rows.map((row) =>
    `<p>• <a href="${row.url}">${row.title}</a> - This retails for $${row.retail}, we are paying $${row.payout}.</p>`).join('\n')}`;
  const id = `pdf-${createHash('sha256').update(bytes).digest('hex')}`;
  const email = { id, messageId: id, sender, subject, body, receivedAt: new Date().toISOString() };
  const parsed = parseBfmrEmail(email);
  if (!parsed.isMultiDealAnnouncement || parsed.deals.length !== rows.length ||
    parsed.deals.some((deal, index) => deal.dealUrl !== rows[index].url)) {
    throw new Error('The shared BFMR intake parser rejected the PDF announcement or changed its deal order.');
  }
  return { status: 'READY' as const, email, rows };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) help();
  const live = args.includes('--live');
  const paths = args.filter((arg) => arg !== '--live');
  if (paths.length > 1 || paths.some((arg) => arg.startsWith('--'))) throw new Error('Provide one PDF path and optionally --live.');
  const pdfPath = path.resolve(paths[0] || samplePdf);
  const result = await readPdfEmail(pdfPath);
  console.log(`PDF: ${pdfPath}`);
  if (result.status === 'SKIPPED') {
    console.log(`Printed sender: ${result.sender}`);
    console.log(`Subject: ${result.subject}`);
    console.log(`SKIPPED: This PDF does not explicitly announce multiple new deals. Found ${result.dealLinkCount} distinct BFMR deal-detail links; no startup, reservation, cancellation, cart, or order action was taken.`);
    return;
  }
  const { email, rows } = result;
  console.log(`Printed sender: ${email.sender}`);
  console.log(`Subject: ${email.subject}`);
  console.log(`Verified ${rows.length} distinct trusted BFMR deal links and matching product bullets:`);
  rows.forEach((row, index) => console.log(`${index + 1}. ${row.title} | payout $${row.payout} | ${row.url}`));
  if (!live) {
    console.log('Preview complete. No reservation, cancellation, cart, or order action was taken.');
    console.log('Use --live only after treating this local PDF as the intended test source; a printout cannot prove email authentication.');
    return;
  }

  requireReservationAlerts();
  const browser = new PlaywrightBfmrBrowser({ headless: false });
  try {
    await runLiveTestStartup(browser);
    await withReservationFailureAlert(`PDF multi-deal test stopped. Source: ${pdfPath}`, () => processEmail(email, browser));
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(`[PDF multi-deal test] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
