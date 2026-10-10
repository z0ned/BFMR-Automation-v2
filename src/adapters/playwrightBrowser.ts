import { chromium, BrowserContext, Page } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';

export interface ReservationSubmissionResult {
  status: 'SUBMITTED' | 'UNCERTAIN' | 'FAILED_500' | 'CLOSED_NO_SLOTS' | 'AUTH_REQUIRED';
  dealId?: string;
  reservationId?: string;
  toastAcknowledgement?: boolean;
  errorDetail?: string;
}

export class PlaywrightBfmrBrowser {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private profilePath: string;
  private isHeadless: boolean;

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
    return this.page;
  }

  /**
   * Verify session on BFMR website (Page 8 verifySession)
   * If login or MFA required, pauses for manual operator completion (OPS-002)
   */
  public async verifySession(expectedAccount?: string): Promise<'AUTHENTICATED' | 'AUTH_REQUIRED'> {
    const page = await this.init();
    console.log('[Playwright] Verifying BFMR website session...');

    await page.goto('https://bfmr.com/deals', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    // Require positive evidence of an authenticated account. A missing login link alone
    // is not proof: BFMR can still be rendering, show an error, or change its navigation.
    const loginSelector = 'a[href*="/login"], button:has-text("Sign In"), a:has-text("Login")';
    const accountSelector = [
      'button[aria-label*="account" i]',
      'a[href*="/my-tracker"]',
      'a[href*="logout" i]',
      'button:has-text("Log out")',
      'a:has-text("Log out")',
    ].join(', ');

    const hasAccountControl = async () =>
      page.isVisible(accountSelector).catch(() => false);
    const isLoginVisible = await page.isVisible(loginSelector).catch(() => false);

    if (!(await hasAccountControl())) {
      console.log('\n⚠️ [BFMR AUTH REQUIRED]');
      console.log(isLoginVisible
        ? 'The saved BFMR browser profile is signed out.'
        : 'Could not confirm a signed-in BFMR account in the browser.');
      console.log('👉 Complete BFMR login or MFA in the browser window.');
      console.log('Waiting for a signed-in account control (up to 5 minutes)...\n');

      try {
        await page.locator(accountSelector).first().waitFor({
          state: 'visible',
          timeout: 300000,
        });
      } catch {
        return 'AUTH_REQUIRED';
      }
    }

    if (expectedAccount) {
      console.log('Confirm the visible BFMR account matches the configured account before continuing.');
    }
    console.log('✅ BFMR website session is authenticated.');
    return 'AUTHENTICATED';
  }

  /**
   * Navigate directly to trusted deal link and submit reservation for quantity 1 (v1.5 FR-005)
   */
  public async submitReservation(dealUrl: string, dealId: string): Promise<ReservationSubmissionResult> {
    const page = await this.init();
    console.log(`\n[Playwright] Navigating directly to deal URL: ${dealUrl}`);

    try {
      await page.goto(dealUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1500); // Allow dynamic React elements to render

      // Check if deal is closed / no slots available
      const noSlotsText = await page.textContent('body').catch(() => '');
      const isClosed = 
        /no slots available/i.test(noSlotsText || '') ||
        /deal closed/i.test(noSlotsText || '') ||
        /sold out/i.test(noSlotsText || '');

      if (isClosed) {
        console.log('⚠️ [Playwright] Deal has NO SLOTS AVAILABLE or is closed.');
        return { status: 'CLOSED_NO_SLOTS', dealId, errorDetail: 'No slots available on deal page' };
      }

      // Check for quantity input (Lock quantity to 1 per MVP 1 rule)
      const qtyInput = await page.$('input[name="quantity"], input[type="number"], input[placeholder*="Qty"], input[aria-label*="Quantity"]');
      if (qtyInput) {
        console.log('[Playwright] Setting quantity to 1...');
        await qtyInput.fill('1');
      }

      // Find reservation button
      const reserveButtonSelector = [
        'button:has-text("Reserve Deal")',
        'button:has-text("Reserve Now")',
        'button:has-text("Reserve")',
        'button[type="submit"]:has-text("Reserve")',
        'a:has-text("Reserve")',
      ].join(', ');

      const reserveBtn = await page.$(reserveButtonSelector);
      if (!reserveBtn) {
        console.log('⚠️ Could not locate Reserve button on page. Checking button states...');
        // Check if disabled
        const disabledBtn = await page.$('button[disabled]:has-text("Reserve")');
        if (disabledBtn) {
          console.log('⚠️ Reserve button is disabled (closed/full).');
          return { status: 'CLOSED_NO_SLOTS', dealId, errorDetail: 'Reserve button is disabled' };
        }
        return { status: 'UNCERTAIN', dealId, errorDetail: 'Reserve button selector not found on page' };
      }

      console.log('👉 [Playwright] Clicking Reserve button for Quantity 1...');
      await reserveBtn.click();

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
        'div:has-text("Reserved successfully"), div:has-text("Reservation created"), div:has-text("Success"), div[class*="toast-success"]',
        { timeout: 8000 }
      ).catch(() => null);

      if (successToast) {
        const text = await successToast.textContent();
        console.log(`✅ [Playwright] Success toast received: "${text?.trim()}"`);
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
    }
  }
}
