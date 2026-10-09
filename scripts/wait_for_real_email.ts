import fs from 'node:fs';
import { parseIncomingEmail } from '../src/services/emailParser';
import { PlaywrightBfmrBrowser } from '../src/adapters/playwrightBrowser';
import { myTrackerService } from '../src/services/myTracker';

// Load .env using Node 22 native support (zero dependency)
if (fs.existsSync('.env')) {
  try {
    process.loadEnvFile();
  } catch (err: any) {
    // ignore if unreadable
  }
}

// Permitted senders per Solution Design Specification v1.5 FR-001
const PERMITTED_SENDERS = [
  'deals@buyformeretail.com',
  'matt.ward@live.com',
];

function isSenderPermitted(senderHeader: string): boolean {
  const lower = senderHeader.toLowerCase();
  return PERMITTED_SENDERS.some((p) => lower.includes(p.toLowerCase()));
}

async function displayParsedDeal(emailData: {
  sender: string;
  subject: string;
  body: string;
  receivedAt: string;
  source: string;
}) {
  console.log('\n' + '='.repeat(80));
  console.log(`[REAL EMAIL DETECTED via ${emailData.source}]`);
  console.log(`Received At: ${emailData.receivedAt}`);
  console.log(`From Header: ${emailData.sender}`);
  console.log(`Subject:     ${emailData.subject}`);
  console.log('-'.repeat(80));

  // Check sender provenance per FR-001
  const isDirectBfmr = emailData.sender.toLowerCase().includes('deals@buyformeretail.com');
  const isMattForward = emailData.sender.toLowerCase().includes('matt.ward@live.com');

  if (!isDirectBfmr && !isMattForward) {
    console.log(`⚠️ SENDER REJECTED: "${emailData.sender}" is not authorized.`);
    console.log(`Allowed Senders (FR-001): deals@buyformeretail.com or forwards from matt.ward@live.com`);
    console.log('='.repeat(80) + '\n');
    return;
  }

  const senderType = isDirectBfmr 
    ? 'Direct BFMR Notification' 
    : 'Testing Forward from matt.ward@live.com (FR-001)';
  console.log(`Sender Verification: PASS (${senderType})`);

  // Parse deal using v1.5 rules
  const parsed = parseIncomingEmail({
    messageId: `<real-msg-${Date.now()}@inbox>`,
    sender: emailData.sender,
    subject: emailData.subject,
    body: emailData.body,
    receivedAt: emailData.receivedAt,
  });

  console.log('\nPARSED ATTRIBUTES:');
  console.log(`  • Classification:     ${parsed.isSingleDeal ? 'QUALIFYING SINGLE DEAL (Accepted)' : 'DISQUALIFIED'}`);
  console.log(`  • Multiple Deals:     ${parsed.isMultiDeal ? 'YES (Ignored per v1.5)' : 'NO'}`);
  console.log(`  • Additional Slots:   ${parsed.isAdditionalSlotNotice ? 'YES (Ignored per v1.5)' : 'NO'}`);
  console.log(`  • Canonical Deal ID:  ${parsed.canonicalDealId || 'NOT FOUND / AMBIGUOUS'}`);
  console.log(`  • Deal Title:         ${parsed.dealTitle}`);
  console.log(`  • Retailer:           ${parsed.retailer}`);
  console.log(`  • Bundle Deal:        ${parsed.isBundle ? 'YES (Quantity 1 for bundle offer)' : 'NO (Single item)'}`);
  console.log(`  • Target Quantity:    1 offer (Strict MVP 1 rule)`);
  console.log(`  • Payout Price:       ${parsed.payoutPrice ? `$${parsed.payoutPrice}` : 'Not specified'}`);
  console.log(`  • Retail Price:       ${parsed.retailPrice ? `$${parsed.retailPrice}` : 'Not specified'}`);
  console.log(`  • Trusted BFMR URL:   ${parsed.dealUrl || 'None (Must match buyformeretail.com)'}`);
  console.log('-'.repeat(80));

  if (parsed.isSingleDeal && parsed.canonicalDealId && parsed.dealUrl) {
    console.log('STATUS: COMMENCING MVP 1 RESERVATION PIPELINE');
    console.log(`\n[Stage 1/3] Duplicate Safeguard: Checking My Tracker for deal "${parsed.canonicalDealId}"...`);

    const trackerCheck = await myTrackerService.checkExistingReservation(parsed.canonicalDealId);
    if (trackerCheck.hasDuplicate) {
      console.log(`⚠️ [DUPLICATE BLOCKED] ${trackerCheck.reason}`);
      console.log(`-> Skipping reservation creation per Specification v1.5 FR-004.\n`);
      return;
    }
    console.log(`✅ [My Tracker Check] No active reservation found for deal "${parsed.canonicalDealId}".`);

    console.log(`\n[Stage 2/3] Launching Playwright browser & navigating to deal...`);
    const browser = new PlaywrightBfmrBrowser();
    try {
      const session = await browser.verifySession(process.env.BFMR_EXPECTED_ACCOUNT);
      if (session !== 'AUTHENTICATED') {
        console.error('❌ Could not establish authenticated session on BFMR website. Halting reservation.');
        return;
      }

      console.log(`\n[Stage 3/3] Submitting quantity 1 reservation on website form...`);
      const result = await browser.submitReservation(parsed.dealUrl, parsed.canonicalDealId);

      if (result.status === 'SUBMITTED') {
        const record = await myTrackerService.recordReservation({
          canonicalDealId: parsed.canonicalDealId,
          title: parsed.dealTitle,
          retailer: parsed.retailer,
        });

        console.log('\n' + '='.repeat(80));
        console.log('🎉 RESERVATION COMPLETED SUCCESSFULLY!');
        console.log(`Deal ID:        ${parsed.canonicalDealId}`);
        console.log(`Title:          ${parsed.dealTitle}`);
        console.log(`Retailer:       ${parsed.retailer}`);
        console.log(`Quantity:       1 offer (v1.5 FR-005 rule)`);
        console.log(`Reservation ID: ${record.rid}`);
        console.log(`Confirmed At:   ${record.reservedAt}`);
        console.log('Matt will release this reservation manually when desired (v1.5 FR-012).');
        console.log('='.repeat(80) + '\n');
      } else if (result.status === 'CLOSED_NO_SLOTS') {
        console.log(`\n⚠️ [SKIPPED] Deal has no slots available or reservation button is disabled.`);
      } else {
        console.log(`\n⚠️ [UNCERTAIN OUTCOME] ${result.errorDetail || 'Browser outcome unclear'}`);
        console.log(`-> Halting retry per v1.5 FR-008 to protect against duplicate commitments.`);
      }
    } finally {
      setTimeout(() => browser.close().catch(() => {}), 3000);
    }
  } else if (parsed.isMultiDeal) {
    console.log('STATUS: SILENT SKIP — Multi-deal emails are excluded from MVP 1.');
  } else if (parsed.isAdditionalSlotNotice) {
    console.log('STATUS: SILENT SKIP — Additional-slot notices are excluded from MVP 1.');
  } else {
    console.log('STATUS: REVIEW REQUIRED — Could not resolve valid BFMR deal link or unrecognized format.');
    const foundUrls = (emailData.body.match(/https?:\/\/[^\s<>"'()[\]]+/gi) || []).slice(0, 5);
    if (foundUrls.length > 0) {
      console.log('Detected Links in Email:');
      foundUrls.forEach((u) => console.log(`  -> ${u}`));
    }
  }
  console.log('='.repeat(80) + '\n');
  console.log('Continuing to wait for next incoming email...\n');
}

/**
 * Method 1: Gmail IMAP Listener (Quickest local setup with App Password)
 */
async function startImapListener() {
  const user = process.env.GMAIL_USER_EMAIL || process.env.IMAP_USER;
  const pass = process.env.GMAIL_APP_PASSWORD || process.env.IMAP_PASSWORD;

  if (!user || !pass) {
    return false;
  }

  let ImapFlow: any;
  try {
    const mod = await import('imapflow');
    ImapFlow = mod.ImapFlow;
  } catch {
    console.error('\n⚠️  Package "imapflow" is not installed yet.');
    console.error('👉 Please run: npm install\n');
    return false;
  }

  console.log(`[IMAP] Connecting to imap.gmail.com as ${user}...`);

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  await client.connect();
  console.log(`[IMAP] Connected securely to Gmail inbox!`);
  console.log(`[IMAP] Watching for new emails from deals@buyformeretail.com or matt.ward@live.com...\n`);

  const lock = await client.getMailboxLock('INBOX');
  try {
    // Process existing unread if any
    const searchResult = await client.search({ unseen: true });
    if (searchResult && searchResult.length > 0) {
      console.log(`[IMAP] Found ${searchResult.length} unread message(s) in inbox, processing latest...`);
      const lastUid = searchResult[searchResult.length - 1];
      const message = await client.fetchOne(lastUid, { envelope: true, source: true });
      if (message) {
        handleRawImapMessage(message);
      }
    }

    // Listen for new messages using IDLE
    client.on('exists', async (data) => {
      try {
        const message = await client.fetchOne(data.count, { envelope: true, source: true });
        if (message) {
          handleRawImapMessage(message);
        }
      } catch (err: any) {
        console.error('[IMAP Fetch Error]:', err.message);
      }
    });

    // Keep IDLE alive
    await client.idle();
  } finally {
    lock.release();
  }

  return true;
}

async function handleRawImapMessage(message: any) {
  const envelope = message.envelope;
  const from = envelope.from?.[0]?.address || envelope.from?.[0]?.name || 'Unknown';
  const subject = envelope.subject || 'No Subject';
  const rawBody = message.source ? message.source.toString('utf-8') : '';

  await displayParsedDeal({
    sender: from,
    subject,
    body: rawBody,
    receivedAt: envelope.date?.toISOString() || new Date().toISOString(),
    source: 'Gmail IMAP Live IDLE',
  });
}

/**
 * Method 2: Google Cloud Pub/Sub StreamingPull (v1.5 Milestone M2 Architecture)
 */
async function startPubSubListener() {
  const subName = process.env.GOOGLE_PUBSUB_SUBSCRIPTION;
  if (!subName) return false;

  const { PubSub } = await import('@google-cloud/pubsub');
  const pubsub = new PubSub();
  const subscription = pubsub.subscription(subName);

  console.log(`[Pub/Sub] Connecting to Google Pub/Sub subscription: ${subName}...`);

  // Initialize Gmail API client using OAuth2 refresh token (production) or GoogleAuth
  let gmailClient: any = null;
  try {
    const { google } = await import('googleapis');
    if (process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN) {
      const oauth2Client = new google.auth.OAuth2(
        process.env.GMAIL_CLIENT_ID,
        process.env.GMAIL_CLIENT_SECRET
      );
      oauth2Client.setCredentials({
        refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      });
      gmailClient = google.gmail({ version: 'v1', auth: oauth2Client });
      console.log(`[Gmail API] Authenticated with user OAuth2 refresh token (OK)`);
    } else {
      const auth = new google.auth.GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      });
      gmailClient = google.gmail({ version: 'v1', auth });
    }
  } catch (err: any) {
    console.log(`[Gmail API Init Note]: ${err.message}`);
  }

  console.log(`[Pub/Sub] Connected! Listening for incoming emails from deals@buyformeretail.com or matt.ward@live.com...`);
  console.log(`[Pub/Sub] Waiting for new messages... (Press Ctrl+C to exit)\n`);

  subscription.on('message', async (message) => {
    try {
      const dataStr = message.data.toString();
      let parsedData: any = {};
      try {
        parsedData = JSON.parse(dataStr);
      } catch {
        parsedData = { raw: dataStr };
      }

      console.log('\n--------------------------------------------------------------------------------');
      console.log(`[Pub/Sub Notification Trigger Received at ${new Date().toLocaleTimeString()}]`);
      if (parsedData.historyId) {
        console.log(`Google History ID: ${parsedData.historyId} for ${parsedData.emailAddress || 'mailbox'}`);
      }

      // Fetch message from Gmail API if client is available
      if (gmailClient) {
        try {
          console.log(`[Gmail API] Fetching latest message from INBOX...`);
          const userMailbox = parsedData.emailAddress || process.env.GMAIL_ACCOUNT_EMAIL || 'me';
          const listRes = await gmailClient.users.messages.list({
            userId: userMailbox,
            maxResults: 3,
            q: 'label:INBOX',
          });

          const msgRefs = listRes.data.messages || [];
          if (msgRefs.length > 0) {
            const latestMsgRef = msgRefs[0];
            const msgRes = await gmailClient.users.messages.get({
              userId: userMailbox,
              id: latestMsgRef.id,
              format: 'full',
            });

            const headers = msgRes.data.payload?.headers || [];
            const fromHeader = headers.find((h: any) => h.name.toLowerCase() === 'from')?.value || 'Unknown';
            const subjectHeader = headers.find((h: any) => h.name.toLowerCase() === 'subject')?.value || 'No Subject';
            const dateHeader = headers.find((h: any) => h.name.toLowerCase() === 'date')?.value || new Date().toISOString();

            // Extract body parts
            let emailBody = '';
            const extractBody = (part: any) => {
              if (part.body?.data) {
                const buff = Buffer.from(part.body.data, 'base64');
                emailBody += buff.toString('utf-8') + '\n';
              }
              if (part.parts) {
                for (const subPart of part.parts) {
                  extractBody(subPart);
                }
              }
            };

            if (msgRes.data.payload) {
              extractBody(msgRes.data.payload);
            }

            await displayParsedDeal({
              sender: fromHeader,
              subject: subjectHeader,
              body: emailBody || msgRes.data.snippet || '',
              receivedAt: dateHeader,
              source: `Google Cloud Pub/Sub + Gmail API (${latestMsgRef.id})`,
            });
          }
        } catch (fetchErr: any) {
          console.error(`[Gmail Fetch Notice]: ${fetchErr.message}`);
          console.log(`(If service account lacks Gmail delegation, ensure GMAIL_USER_EMAIL + GMAIL_APP_PASSWORD are set for direct IMAP fallback).`);
        }
      } else {
        console.log(`Notification payload:`, parsedData);
      }

      message.ack();
    } catch (e: any) {
      console.error('[Pub/Sub Processing Error]:', e.message);
    }
  });

  subscription.on('error', (err) => {
    console.error('[Pub/Sub Subscription Error]:', err.message);
  });

  return true;
}

async function main() {
  console.log('='.repeat(80));
  console.log('BFMR AUTOMATION v2 — REAL EMAIL LISTENER & PARSER TEST');
  console.log('Target Senders (FR-001): deals@buyformeretail.com & matt.ward@live.com');
  console.log('Authoritative Baseline: Solution Design Specification v1.5');
  console.log('='.repeat(80));

  // Try IMAP first (direct, fastest for testing)
  let started = false;
  try {
    started = await startImapListener();
  } catch (err: any) {
    console.log(`[IMAP Note]: ${err.message}`);
  }

  // Try Pub/Sub if IMAP not configured
  if (!started) {
    try {
      started = await startPubSubListener();
    } catch (err: any) {
      console.log(`[Pub/Sub Note]: ${err.message}`);
    }
  }

  if (!started) {
    console.log('\n[CONFIGURATION NEEDED ON YOUR LOCAL HOST]');
    console.log('To listen to your real inbox without passing secrets to AI Studio, configure');
    console.log('your local .env file on your machine (/home/wardmatt/...):\n');
    console.log('OPTION 1 (Recommended - Quickest Gmail Setup with Google App Password):');
    console.log('  Add to your local .env:');
    console.log('    GMAIL_USER_EMAIL=your-gmail@gmail.com');
    console.log('    GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx  (16-letter App Password from myaccount.google.com/apppasswords)\n');
    console.log('OPTION 2 (Full Google Cloud Pub/Sub from v1.5):');
    console.log('  Add to your local .env:');
    console.log('    GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json');
    console.log('    GOOGLE_PUBSUB_SUBSCRIPTION=projects/YOUR_PROJECT/subscriptions/YOUR_SUBSCRIPTION\n');
    console.log('Then re-run:');
    console.log('  npm run test-real-email\n');
  }
}

main().catch(console.error);
