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

    // Check if sign-in button or login page is visible
    const isLoginVisible = await page.isVisible('a[href*="/login"], button:has-text("Sign In"), a:has-text("Login")').catch(() => false);
    const isUserMenuVisible = await page.isVisible('button[aria-label*="account"], div:has-text("Logout"), a[href*="/my-tracker"]').catch(() => false);

    if (isLoginVisible && !isUserMenuVisible) {
      console.log('\n⚠️ [BFMR AUTH REQUIRED]');
      console.log('You are not currently logged in on the BFMR website in Chromium.');
      console.log('👉 Please log in to your BFMR account in the browser window now.');
      console.log('Waiting for login completion in browser (up to 120 seconds)...\n');

      try {
        await page.waitForSelector('a[href*="/my-tracker"], button:has-text("Logout"), div[class*="avatar"]', {
          timeout: 120000,
        });
        console.log('✅ Logged in successfully!');
        return 'AUTHENTICATED';
      } catch {
        return 'AUTH_REQUIRED';
      }
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
