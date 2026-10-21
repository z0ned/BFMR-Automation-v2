import './loadEnv';
import type { Page } from 'playwright';
import { PlaywrightBfmrBrowser } from '../src/adapters/playwrightBrowser';
import { verifyBfmrAccountIdentity } from '../src/services/bfmrAccountIdentity';
import { readRecentReservedRows } from '../src/services/bfmrTrackerApi';
import { isTrustedBfmrHost } from '../src/services/bfmrUrl';

// Deliberately independent of live startup, relational runtime, Gmail and alerting.
// Attach only to an existing exact-PID browser; never create a profile or log in.
const args = process.argv.slice(2);
const required = [
  'BFMR_EXPECTED_ACCOUNT', 'BFMR_API_KEY', 'BFMR_API_SECRET', 'BFMR_TRACKER_URL',
  'BFMR_ACCOUNT_IDENTITY_SELECTOR', 'BFMR_TRACKER_BROWSER_URL',
  'BFMR_ACCOUNT_PROOF_RESERVE_ID', 'BFMR_ACCOUNT_RESERVATION_SELECTOR',
] as const;

interface Report {
  diagnostic: 'BFMR_EV001';
  observedAt: string;
  verified: boolean;
  reason: string;
  missingConfiguration?: string[];
  checks: {
    browserAttached: boolean;
    existingBfmrTab: boolean;
    proofPageReadGuard: boolean;
    completeApiRead: boolean;
    uniqueApiReservation: boolean;
    apiDealPresent: boolean;
  };
  blockedRequests: number;
}

async function main(): Promise<void> {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage (Ubuntu container, from repository root):');
    console.log('  npm run inspect-bfmr-identity -- --browser-pid <existing Chromium PID>');
    console.log('BFMR_CHROMIUM_PID may supply the PID instead.');
    console.log('Requires private BFMR account/API/selector configuration and an existing signed-in BFMR tab.');
    console.log('Uses only tracker reads; no startup, reservation, cancellation, order, database or alert actions.');
    console.log('Emits sanitized JSON plus browser attachment information; share only the JSON report.');
    console.log('Never paste credentials, account pages or actual IDs into chat.');
    return;
  }

  const report: Report = {
    diagnostic: 'BFMR_EV001', observedAt: new Date().toISOString(), verified: false,
    reason: 'NOT_STARTED', blockedRequests: 0,
    checks: { browserAttached: false, existingBfmrTab: false, proofPageReadGuard: false,
      completeApiRead: false, uniqueApiReservation: false, apiDealPresent: false },
  };
  let browser: PlaywrightBfmrBrowser | undefined;
  try {
    let rawPid = process.env.BFMR_CHROMIUM_PID;
    if (args.length === 2 && args[0] === '--browser-pid') rawPid = args[1];
    else if (args.length === 1 && args[0].startsWith('--browser-pid=')) rawPid = args[0].slice(14);
    else if (args.length !== 0) { report.reason = 'INVALID_ARGUMENTS'; return; }

    const missing = required.filter(name => !process.env[name]?.trim());
    if (missing.length) {
      report.reason = 'CONFIGURATION_MISSING'; report.missingConfiguration = missing; return;
    }
    if (!rawPid || !/^\d+$/.test(rawPid) || !Number.isSafeInteger(Number(rawPid)) || Number(rawPid) < 2) {
      report.reason = 'EXISTING_BROWSER_PID_REQUIRED'; return;
    }

    report.reason = 'INVALID_TRACKER_CONFIGURATION';
    const target = new URL(process.env.BFMR_TRACKER_BROWSER_URL!);
    const endpoint = new URL(process.env.BFMR_TRACKER_URL!);
    if (target.protocol !== 'https:' || target.username || target.password || target.port ||
        target.hash || !isTrustedBfmrHost(target.hostname) ||
        endpoint.protocol !== 'https:' || endpoint.hostname !== 'api.bfmr.com' ||
        endpoint.username || endpoint.password || endpoint.port || endpoint.search || endpoint.hash) return;

    report.reason = 'BROWSER_ATTACHMENT_FAILED';
    browser = new PlaywrightBfmrBrowser({ browserPid: Number(rawPid) });
    const attached = await browser.init();
    report.checks.browserAttached = true;
    const existing = attached.context().pages().find(page => {
      try { return new URL(page.url()).origin === target.origin; } catch { return false; }
    });
    if (!existing) { report.reason = 'EXISTING_SAME_ORIGIN_BFMR_TAB_REQUIRED'; return; }
    report.checks.existingBfmrTab = true;

    // The existing complete-read parser remains authoritative. This transport
    // permits only its paging GETs to the configured bare endpoint, no redirects.
    const readOnlyFetch: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if ((init?.method ?? 'GET') !== 'GET' || url.origin !== endpoint.origin ||
          url.pathname !== endpoint.pathname || url.username || url.password || url.hash ||
          [...url.searchParams.keys()].some(key => !['page_no', 'page_size'].includes(key))) {
        throw new Error('READ_ONLY_API_REQUEST_REJECTED');
      }
      return fetch(input, { ...init, method: 'GET', redirect: 'error' });
    };
    const readRows = async () => {
      report.reason = 'API_READ_FAILED';
      const rows = await readRecentReservedRows(readOnlyFetch);
      report.checks.completeApiRead = true;
      const matches = rows.filter(row => String(row.reserve_id) === process.env.BFMR_ACCOUNT_PROOF_RESERVE_ID);
      report.checks.uniqueApiReservation = matches.length === 1;
      report.checks.apiDealPresent = matches.length === 1 && Boolean(String(matches[0].deal_id ?? '').trim());
      report.reason = matches.length === 0 ? 'KNOWN_API_RESERVATION_MISSING'
        : matches.length !== 1 ? 'KNOWN_API_RESERVATION_AMBIGUOUS'
        : !report.checks.apiDealPresent ? 'API_DEAL_ID_MISSING' : 'BROWSER_RESERVATION_PROOF_FAILED';
      return rows;
    };
    const prepareProofPage = async (proofPage: Page) => {
      // These controls apply only to the new proof tab. No existing tab is
      // navigated, and no login, storage manipulation, clicks or forms are used.
      const cdp = await proofPage.context().newCDPSession(proofPage);
      await cdp.send('Network.setBypassServiceWorker', { bypass: true });
      await proofPage.route('**/*', async route => {
        const request = route.request();
        let allowed = false;
        try {
          const url = new URL(request.url());
          allowed = ['GET', 'HEAD', 'OPTIONS'].includes(request.method()) &&
            !url.username && !url.password &&
            [target.origin, endpoint.origin].includes(url.origin);
          if (request.isNavigationRequest()) {
            allowed = allowed && request.frame() === proofPage.mainFrame() &&
              url.origin === target.origin && url.pathname === target.pathname && url.search === target.search;
          }
        } catch { /* Unrecognized requests fail closed. */ }
        try {
          if (allowed) {
            // Page routing alone does not intercept later redirect hops.
            // Fetch one hop, refuse redirects, then fulfill the guarded read.
            const response = await route.fetch({ maxRedirects: 0, timeout: 15000 });
            if (response.status() < 300 || response.status() >= 400) {
              await route.fulfill({ response }); return;
            }
          }
          report.blockedRequests += 1;
          await route.abort('blockedbyclient');
        } catch {
          report.blockedRequests += 1;
          await route.abort('blockedbyclient').catch(() => {});
        }
      });
      await proofPage.routeWebSocket('**/*', async socket => {
        report.blockedRequests += 1; await socket.close().catch(() => {});
      });
      report.checks.proofPageReadGuard = true;
    };

    report.reason = 'BROWSER_ACCOUNT_PROOF_FAILED';
    report.verified = await verifyBfmrAccountIdentity(existing, process.env.BFMR_EXPECTED_ACCOUNT,
      readRows, process.env, prepareProofPage);
    if (report.verified) report.reason = 'EXACT_ACCOUNT_RESERVATION_AND_DEAL_MATCH';
  } catch {
    // Raw exceptions may contain selectors, URLs or private provider responses.
    // Keep only the sanitized stage set before the failing operation.
  } finally {
    await browser?.close(); // CDP disconnect only; leaves the operator's browser running.
    console.log(JSON.stringify(report, null, 2));
    if (!report.verified) process.exitCode = 1;
  }
}

await main();
