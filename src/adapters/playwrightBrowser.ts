import { chromium, BrowserContext, Page } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { isTrustedBfmrDealUrl, isTrustedBfmrDealsListingUrl, isTrustedBfmrHost, TRUSTED_BFMR_HOSTS } from '../services/bfmrUrl';
import { describeDealTitleFailure, readVisibleDealTitle } from '../services/visibleDealTitle';
import { getVisibleDealUnavailableReason } from '../services/dealAvailability';

export interface ReservationSubmissionResult {
  status: 'SUBMITTED' | 'UNCERTAIN' | 'FAILED_500' | 'CLOSED_NO_SLOTS' | 'AUTH_REQUIRED' | 'CHALLENGE';
  dealId?: string;
  reservationId?: string;
  toastAcknowledgement?: boolean;
  errorDetail?: string;
  definitiveNonCreation?: boolean;
}

async function hasAccessChallenge(page: Page): Promise<boolean> {
  const challengeSelectors = [
    'iframe[src*="captcha" i]',
    'iframe[title*="captcha" i]',
    '[id*="captcha" i]',
    '[class*="captcha" i]',
    'textarea[name*="captcha" i]',
    'input[name*="captcha" i]',
    '[data-sitekey]',
    '[class*="turnstile" i]',
    'iframe[src*="challenges.cloudflare.com" i]',
  ];
  for (const selector of challengeSelectors) {
    if (await page.locator(selector).first().isVisible().catch(() => false)) return true;
  }

  const bodyText = await page.locator('body').innerText().catch(() => '');
  return /captcha|verify\s+(?:that\s+)?you(?:'|’)re human|prove\s+you(?:'|’)re human|unusual traffic|automated requests/i.test(bodyText);
}

export class PlaywrightBfmrBrowser {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private profilePath: string;
  private isHeadless: boolean;
  private verifiedDealTarget: string | null = null;

  constructor(options?: { profilePath?: string; headless?: boolean }) {
    this.profilePath = options?.profilePath || 
      process.env.CHROMIUM_PROFILE_PATH || 
      path.resolve(process.env.HOME || '/home/wardmatt', '.config/bfmr/chromium-profile');
    
    // Default to HEADED mode per v1.5 Page 4/15 specification
    this.isHeadless = options?.headless !== undefined 
      ? options.headless 
      : process.env.PLAYWRIGHT_HEADLESS === 'true';

    if (!fs.existsSync(this.profilePath)) {
      fs.mkdirSync(this.profilePath, { recursive: true });
    }
  }

  public async init(): Promise<Page> {
    if (this.context && this.page) {
      return this.page;
    }

    console.log(`[Playwright] Launching Chromium (headed: ${!this.isHeadless})`);
    console.log(`[Playwright] Profile: ${this.profilePath}`);

    this.context = await chromium.launchPersistentContext(this.profilePath, {
      headless: this.isHeadless,
      viewport: { width: 1280, height: 800 },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    const pages = this.context.pages();
    this.page = pages.length > 0 ? pages[0] : await this.context.newPage();
    const activePage = this.page;
    activePage.on('framenavigated', (frame) => {
      if (frame !== activePage.mainFrame()) return;
      try {
        const url = new URL(frame.url());
        if (isTrustedBfmrDealUrl(url.href) || isTrustedBfmrDealsListingUrl(url.href)) {
          console.log(`[Playwright] Main page navigation: ${url.origin}${url.pathname}`);
        } else if (isTrustedBfmrHost(url.hostname)) {
          console.log('[Playwright] Main page navigation: another BFMR route (details omitted)');
        } else if (url.protocol === 'https:' || url.protocol === 'http:') {
          console.log('[Playwright] Main page navigation: unapproved host (details omitted)');
        }
      } catch { /* Ignore non-HTTP browser-internal pages. */ }
    });
    return this.page;
  }

  /**
   * Verify session on BFMR website (Page 8 verifySession)
   * If login or MFA required, pauses for manual operator completion (OPS-002)
   */
  public async verifySession(expectedAccount?: string, dealUrl?: string): Promise<
    'AUTHENTICATED' | 'AUTH_REQUIRED' | 'UNTRUSTED_REDIRECT' | 'DEAL_PAGE_MISMATCH' | 'PAGE_ERROR' | 'CHALLENGE'
  > {
    const page = await this.init();
    this.verifiedDealTarget = null;
    console.log('[Playwright] Verifying BFMR website session...');

    const destination = dealUrl || 'https://www.bfmr.com/deals';
    if (dealUrl && !isTrustedBfmrDealUrl(dealUrl)) {
      console.error('[Playwright] Refusing an untrusted deal URL during session verification.');
      return 'AUTH_REQUIRED';
    }

    // In the real-email runner, inspect the exact deal page from the email. This
    // avoids replacing it with the generic deals listing during session checks.
    console.log(`[Playwright] Requested page: ${new URL(destination).origin}${new URL(destination).pathname}`);
    const response = await page.goto(destination, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    if (await hasAccessChallenge(page)) {
      console.error('[Playwright] BFMR presented a CAPTCHA/access challenge. Stopping for manual handling.');
      return 'CHALLENGE';
    }

    // BFMR's signed-in page does not expose a stable account-menu selector. Detect
    // sign-in state from the login route/form itself instead of requiring a guessed
    // account button that may not exist in the signed-in UI.
    const loginSelector = [
      'input[type="password"]',
      'form[action*="login" i]',
      'a[href*="/login"]',
      'button:has-text("Sign In")',
      'a:has-text("Sign In")',
      'button:has-text("Log In")',
      'a:has-text("Log In")',
    ].join(', ');
    const isLoginRoute = /\/(login|signin|sign-in|auth)(\/|$)/i.test(new URL(page.url()).pathname);
    const isLoginVisible = await page.locator(loginSelector).first().isVisible().catch(() => false);
    let pageHasContent = await page.locator('body').evaluate((body) => (body.textContent || '').trim().length > 0).catch(() => false);
    let badResponse = response ? response.status() >= 400 : false;
    const finalUrl = new URL(page.url());
    const expectedPath = dealUrl ? new URL(dealUrl).pathname.replace(/\/+$/, '') : undefined;

    if (isLoginRoute || isLoginVisible) {
      console.log('\n⚠️ [BFMR AUTH REQUIRED]');
      console.log('BFMR is showing its sign-in page or form.');
      console.log('👉 Complete BFMR login or MFA in the browser window.');
      console.log('Waiting for the login form to disappear and BFMR to load (up to 5 minutes)...\n');

      try {
        await page.waitForFunction(({
          trustedHosts,
        }: { trustedHosts: string[] }) => {
          const path = window.location.pathname;
          const authRoute = /\/(login|signin|sign-in|auth)(\/|$)/i.test(path);
          const passwordField = Array.from(document.querySelectorAll('input[type="password"]'))
            .some((input) => (input as HTMLElement).offsetParent !== null);
          const pageText = (document.body?.innerText || '').trim();
          const allowedHost = trustedHosts.includes(window.location.hostname.toLowerCase());
          return allowedHost && !authRoute && !passwordField && pageText.length > 0;
        }, { trustedHosts: [...TRUSTED_BFMR_HOSTS] }, {
          timeout: 300000,
        });
      } catch {
        const currentUrl = new URL(page.url());
        if (!isTrustedBfmrHost(currentUrl.hostname)) {
          console.error(`[Playwright] BFMR login flow ended on unapproved host: ${currentUrl.hostname}`);
          return 'UNTRUSTED_REDIRECT';
        }
        const stillOnLogin = /\/(login|signin|sign-in|auth)(\/|$)/i.test(currentUrl.pathname) ||
          await page.locator('input[type="password"]').isVisible().catch(() => false);
        if (stillOnLogin) return 'AUTH_REQUIRED';
        if (dealUrl && !isTrustedBfmrDealUrl(currentUrl.href)) {
          console.error(`[Playwright] BFMR login flow reached an approved host, but not a BFMR deal-detail page (path: ${currentUrl.pathname}).`);
          return 'DEAL_PAGE_MISMATCH';
        }
        return 'PAGE_ERROR';
      }
      // The first response may have been the sign-in page. Reassess the page
      // after the operator completes login instead of carrying that state forward.
      if (await hasAccessChallenge(page)) {
        console.error('[Playwright] BFMR presented a CAPTCHA/access challenge during sign-in. Stopping for manual handling.');
        return 'CHALLENGE';
      }
      pageHasContent = await page.locator('body').evaluate((body) => (body.textContent || '').trim().length > 0).catch(() => false);
      badResponse = false;
    }

    const authenticatedUrl = new URL(page.url());
    if (!isTrustedBfmrHost(authenticatedUrl.hostname)) {
      console.error(`[Playwright] BFMR navigation ended on unapproved host: ${authenticatedUrl.hostname}`);
      return 'UNTRUSTED_REDIRECT';
    }
    if (dealUrl) {
      // BFMR may replace an email URL with its canonical deal slug. Keep the
      // redirect on an approved host and a deal-detail route; reject listings.
      if (!isTrustedBfmrDealUrl(authenticatedUrl.href)) {
        console.error(`[Playwright] BFMR host is approved, but the redirect did not land on a BFMR deal-detail page (path: ${authenticatedUrl.pathname}).`);
        return 'DEAL_PAGE_MISMATCH';
      }
      if (expectedPath && authenticatedUrl.pathname.replace(/\/+$/, '').toLowerCase() !== expectedPath.toLowerCase()) {
        console.log('[Playwright] BFMR redirected to a canonical deal-detail path on an approved host.');
      }
    }
    if (badResponse || !pageHasContent) {
      console.error('[Playwright] BFMR did not return a usable deal page.');
      return 'PAGE_ERROR';
    }

    if (expectedAccount) {
      console.log('Confirm the visible BFMR account matches the configured account before continuing.');
    }
    this.verifiedDealTarget = dealUrl || null;
    console.log('✅ BFMR website session is authenticated.');
    return 'AUTHENTICATED';
  }

  /** Confirm an operator has completed a visible BFMR challenge without automating it. */
  public async confirmCurrentDealPageAfterManualAccess(dealUrl: string): Promise<boolean> {
    const page = await this.init();
    if (!isTrustedBfmrDealUrl(dealUrl)) return false;
    const currentUrl = page.url();
    if (!isTrustedBfmrDealUrl(currentUrl) || await hasAccessChallenge(page)) return false;

    const loginSelector = [
      'input[type="password"]',
      'form[action*="login" i]',
      'button:has-text("Sign In")',
      'a:has-text("Sign In")',
      'button:has-text("Log In")',
      'a:has-text("Log In")',
    ].join(', ');
    if (await page.locator(loginSelector).first().isVisible().catch(() => false)) return false;
    if (!(await page.locator('body').innerText().then((text) => text.trim().length > 0).catch(() => false))) return false;

    this.verifiedDealTarget = dealUrl;
    return true;
  }

  /** Read the BFMR catalog title used to match the API tracker row. */
  public async getVisibleDealTitle(): Promise<string | null> {
    const page = await this.init();
    if (isTrustedBfmrDealsListingUrl(page.url())) {
      throw new Error('BFMR reached the deals listing instead of the requested deal. This does not prove the deal is full. No reservation was attempted.');
    }
    if (!isTrustedBfmrDealUrl(page.url())) return null;
    const title = await readVisibleDealTitle(page);
    if (isTrustedBfmrDealsListingUrl(page.url())) {
      throw new Error('BFMR left the deal page for the deals listing during preflight. This does not prove the deal is full. No reservation was attempted.');
    }
    if (!title) console.log(`[Playwright] Deal title diagnostics: path=${new URL(page.url()).pathname}; ${await describeDealTitleFailure(page)}`);
    return title;
  }

  public async isCurrentDealUnavailable(): Promise<boolean> {
    return (await this.getCurrentDealUnavailableReason()) !== null;
  }

  public async getCurrentDealUnavailableReason(): Promise<string | null> {
    const page = await this.init();
    const url = page.url();
    if (!isTrustedBfmrDealUrl(url)) return null;
    if (await hasAccessChallenge(page)) return null;
    return getVisibleDealUnavailableReason(page);
  }

  /** Wait for the human to finish access challenges without a terminal prompt. */
  public async waitForManualAccess(): Promise<void> {
    const page = await this.init();
    const deadline = Date.now() + 300000;
    let announced = false;
    while (await hasAccessChallenge(page)) {
      if (!announced) { console.log('[Playwright] Complete the CAPTCHA manually in this browser; processing resumes automatically.'); announced = true; }
      if (Date.now() >= deadline) throw new Error('Manual CAPTCHA completion timed out; no automatic reservation retry.');
      await page.waitForTimeout(1000);
    }
    if (!isTrustedBfmrHost(new URL(page.url()).hostname) ||
      await page.locator('input[type="password"]').first().isVisible()) throw new Error('BFMR authentication is unresolved.');
  }

  public async getStartupDealUrls(): Promise<string[]> {
    const session = await this.verifySession(process.env.BFMR_EXPECTED_ACCOUNT);
    if (session !== 'AUTHENTICATED' && session !== 'CHALLENGE') throw new Error(`Startup BFMR session failed: ${session}`);
    await this.waitForManualAccess();
    const page = await this.init();
    if (!isTrustedBfmrDealsListingUrl(page.url())) throw new Error('Startup did not reach the trusted BFMR deals listing.');
    const links = page.locator('a[href*="/deals/"]:visible');
    await links.first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
    const urls = await links.evaluateAll((elements) => elements.map((element) => (element as HTMLAnchorElement).href));
    return [...new Set(urls.filter(isTrustedBfmrDealUrl))];
  }

  public async inspectStartupDeal(url: string): Promise<{ url: string; id: string; title: string } | null> {
    const session = await this.verifySession(process.env.BFMR_EXPECTED_ACCOUNT, url);
    if (session !== 'AUTHENTICATED' && session !== 'CHALLENGE') throw new Error(`Startup deal session failed: ${session}`);
    await this.waitForManualAccess();
    if (!(await this.confirmCurrentDealPageAfterManualAccess(url))) throw new Error('Startup deal could not be verified.');
    if (await this.isCurrentDealUnavailable()) return null;
    const title = await this.getVisibleDealTitle();
    if (await this.isCurrentDealUnavailable()) return null;
    if (!title) throw new Error('Startup deal has no unambiguous catalog title.');
    const page = await this.init();
    const canonicalUrl = page.url();
    if (!isTrustedBfmrDealUrl(canonicalUrl)) throw new Error('Startup lost the individual deal page.');
    const id = new URL(canonicalUrl).pathname.split('/').filter(Boolean).at(-1)!;
    return { url: canonicalUrl, id, title };
  }

  /**
   * Navigate directly to trusted deal link and submit reservation for quantity 1 (v1.5 FR-005)
   */
  public async submitReservation(dealUrl: string, dealId: string): Promise<ReservationSubmissionResult> {
    const page = await this.init();
    if (!isTrustedBfmrDealUrl(dealUrl)) {
      return { status: 'AUTH_REQUIRED', dealId, errorDetail: 'Refusing an untrusted BFMR deal URL' };
    }
    console.log(`\n[Playwright] Navigating directly to deal URL: ${dealUrl}`);

    try {
      const canReuseVerifiedPage = this.verifiedDealTarget === dealUrl && isTrustedBfmrDealUrl(page.url());
      if (canReuseVerifiedPage) {
        console.log('[Playwright] Using the already verified BFMR deal page.');
      } else {
        await page.goto(dealUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(500); // Let the deal form finish its client-side render
      }

      if (await hasAccessChallenge(page)) {
        return {
          status: 'CHALLENGE',
          dealId,
          errorDetail: 'BFMR presented a CAPTCHA/access challenge; no reservation action was taken',
        };
      }

      // Check if deal is closed / no slots available
      if (await this.isCurrentDealUnavailable()) {
        console.log('⚠️ [Playwright] Deal reservation page is unavailable.');
        return { status: 'CLOSED_NO_SLOTS', dealId, errorDetail: 'Deal reservation page is unavailable before submission' };
      }

      // BFMR enables its submit action only after a variant's quantity spinner is
      // incremented. Select exactly one variant for one unit, as required by FR-005.
      const quantityInputSelector = [
        'input[type="number"]',
        'input[role="spinbutton"]',
        'input[name*="quantity" i]',
        'input[aria-label*="quantity" i]',
        'input[placeholder*="quantity" i]',
      ].join(', ');
      const quantityInputs = page.locator(quantityInputSelector);
      // The deal's variant rows are populated asynchronously. Wait for the
      // Quantity controls to exist and become interactable before deciding the
      // form is unavailable.
      await page.waitForFunction((selector) => {
        return Array.from(document.querySelectorAll<HTMLInputElement>(selector)).some((input) => {
          const style = window.getComputedStyle(input);
          const visible = style.display !== 'none' && style.visibility !== 'hidden' && input.getClientRects().length > 0;
          return visible && !input.disabled && input.getAttribute('aria-disabled') !== 'true';
        });
      }, quantityInputSelector, { timeout: 20000 }).catch(() => {});
      if (await this.isCurrentDealUnavailable()) {
        return { status: 'CLOSED_NO_SLOTS', dealId, errorDetail: 'Deal reservation page became unavailable before quantity selection' };
      }
      const quantityCount = await quantityInputs.count();
      const availableInputs: Array<{ input: typeof quantityInputs; quantity: number }> = [];

      for (let index = 0; index < quantityCount; index += 1) {
        const input = quantityInputs.nth(index);
        if (!(await input.isVisible().catch(() => false)) || !(await input.isEnabled().catch(() => false))) {
          continue;
        }

        const rawQuantity = (await input.inputValue()).trim();
        const quantity = rawQuantity === '' ? 0 : Number(rawQuantity);
        if (!Number.isFinite(quantity) || quantity < 0) {
          return { status: 'UNCERTAIN', dealId, errorDetail: 'A quantity control contains an invalid value' };
        }
        availableInputs.push({ input, quantity });
      }

      if (availableInputs.length === 0) {
        const disabledCount = await quantityInputs.count();
        const pageTitle = await page.title().catch(() => 'unknown title');
        return {
          status: 'UNCERTAIN',
          dealId,
          errorDetail: `No visible enabled quantity controls appeared on the deal form (matched ${disabledCount} candidate(s); page: ${pageTitle})`,
        };
      }

      const alreadySelected = availableInputs.filter(({ quantity }) => quantity > 0);
      if (alreadySelected.length > 1 || alreadySelected.some(({ quantity }) => quantity !== 1)) {
        return { status: 'UNCERTAIN', dealId, errorDetail: 'The form has a quantity selection other than exactly one unit on one variant' };
      }

      let selectedInput = alreadySelected[0]?.input;
      if (!selectedInput) {
        selectedInput = availableInputs[0].input;
        console.log('[Playwright] Selecting one unit with the quantity spinner arrow...');
        await selectedInput.focus();
        await selectedInput.press('ArrowUp');
      }

      const selectedQuantity = Number((await selectedInput.inputValue()).trim());
      const quantitiesAfterSelection = await Promise.all(
        availableInputs.map(async ({ input }) => Number((await input.inputValue()).trim() || '0'))
      );
      if (selectedQuantity !== 1 || quantitiesAfterSelection.filter((quantity) => quantity > 0).length !== 1) {
        return { status: 'UNCERTAIN', dealId, errorDetail: 'Could not confirm exactly one selected unit on the deal form' };
      }

      const reserveButton = page.getByRole('button', { name: /^Reserve Quantity$/i }).first();
      if (await reserveButton.count() === 0) {
        console.log('⚠️ Could not locate the Reserve Quantity button after selecting quantity 1.');
        return { status: 'UNCERTAIN', dealId, errorDetail: 'Reserve Quantity button was not found after quantity selection' };
      }

      await reserveButton.waitFor({ state: 'visible', timeout: 5000 });
      for (let attempt = 0; attempt < 15 && !(await reserveButton.isEnabled()); attempt += 1) {
        await page.waitForTimeout(200);
      }
      if (!(await reserveButton.isEnabled())) {
        return { status: 'UNCERTAIN', dealId, errorDetail: 'Reserve Quantity remained disabled after selecting one unit' };
      }

      if (await this.isCurrentDealUnavailable()) {
        return { status: 'CLOSED_NO_SLOTS', dealId, errorDetail: 'Deal reservation page became unavailable before submission' };
      }

      console.log('👉 [Playwright] Clicking Reserve Quantity for one unit...');
      await reserveButton.click();

      // Check for modal confirmation or toast
      await page.waitForTimeout(1000);
      const confirmModalBtn = await page.$('div[role="dialog"] button:has-text("Confirm"), div[role="dialog"] button:has-text("Reserve"), button:has-text("Yes, Reserve")');
      if (confirmModalBtn) {
        console.log('[Playwright] Confirming reservation in popup dialog...');
        await confirmModalBtn.click();
      }

      // Wait for success toast or confirmation message
      console.log('[Playwright] Waiting for submission acknowledgement...');
      const successToast = await page.waitForSelector(
        '[role="alert"]:has-text("Reserved successfully"), [role="status"]:has-text("Reserved successfully"), [role="alert"]:has-text("Reservation created"), [role="status"]:has-text("Reservation created"), div[class*="toast-success"]:has-text("Reserved"), div[class*="toast-success"]:has-text("Reservation created")',
        { timeout: 8000 }
      ).catch(() => null);

      if (successToast) {
        console.log('✅ [Playwright] BFMR showed an explicit reservation acknowledgement.');
        return {
          status: 'SUBMITTED',
          dealId,
          toastAcknowledgement: true,
        };
      }

      // If no explicit toast but page redirected or button changed to Reserved
      const isNowReserved = await page.isVisible('button:has-text("Reserved"), div:has-text("You have reserved")').catch(() => false);
      if (isNowReserved) {
        console.log('✅ [Playwright] Button changed to Reserved state!');
        return {
          status: 'SUBMITTED',
          dealId,
          toastAcknowledgement: true,
        };
      }

      console.log('ℹ️ [Playwright] Submission completed (verifying with My Tracker)...');
      return {
        status: 'SUBMITTED',
        dealId,
        toastAcknowledgement: false,
      };
    } catch (err: any) {
      console.error(`❌ [Playwright Error]: ${err.message}`);
      return {
        status: 'UNCERTAIN',
        dealId,
        errorDetail: err.message,
      };
    }
  }

  public async close(): Promise<void> {
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
      this.page = null;
      this.verifiedDealTarget = null;
    }
  }

  /** A retailer tab shares cookies/profile with the existing browser, not the BFMR page. */
  public async createRetailerTab(): Promise<Page> {
    const bfmrPage = await this.init();
    return bfmrPage.context().newPage();
  }
}
