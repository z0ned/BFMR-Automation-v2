import './loadEnv';
import { parseBfmrEmail as parseIncomingEmail } from '../src/services/bfmrEmailLinks';

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
  console.log(`Sender Filter Match (authentication not established) (${senderType})`);

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

  // Parser diagnostics cannot use synthetic tracker state to authorize a
  // provider mutation. The maintained runner owns account/persistence gates.
  console.log('STATUS: PARSER DIAGNOSTIC ONLY — no reservation action is performed.');
  console.log('Use npm run test-real-email for the separately authorized, gated workflow.');
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
    client.on('exists', async (data: { count: number }) => {
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
    console.log('\n[NO EMAIL LISTENER COULD BE STARTED]');
    console.log('Configuration was loaded from .env in this directory and, if present, ~/.env.bfmr_automation or ~/.env.');

    if (!process.env.GMAIL_USER_EMAIL || !process.env.GMAIL_APP_PASSWORD) {
      console.log('IMAP needs both GMAIL_USER_EMAIL and GMAIL_APP_PASSWORD.');
    }
    if (!process.env.GOOGLE_PUBSUB_SUBSCRIPTION) {
      console.log('Pub/Sub needs GOOGLE_PUBSUB_SUBSCRIPTION.');
    }
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      console.log('Pub/Sub needs Google credentials; set GOOGLE_APPLICATION_CREDENTIALS or place the service-account file at ~/.bfmr/gcp-credentials.json.');
    }

    console.log('Check the variable names and paths above, then re-run npm run test-real-email.\n');
  }
}

main().catch(console.error);
