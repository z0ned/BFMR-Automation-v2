import fs from 'node:fs';
import { parseBfmrEmail as parseIncomingEmail } from '../src/services/bfmrEmailLinks';

// Load .env
if (fs.existsSync('.env')) {
  try {
    process.loadEnvFile();
  } catch {}
}

async function debugGmailIntake() {
  console.log('='.repeat(80));
  console.log('BFMR AUTOMATION v2 — GMAIL & PUB/SUB INTAKE DIAGNOSTIC TOOL');
  console.log('='.repeat(80));

  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const subName = process.env.GOOGLE_PUBSUB_SUBSCRIPTION;
  const topicName = process.env.GOOGLE_PUBSUB_TOPIC;
  const userMailbox = process.env.GMAIL_ACCOUNT_EMAIL || 'me';

  console.log('\n[1. Environment Check]');
  console.log(`  • GOOGLE_APPLICATION_CREDENTIALS: ${credPath || 'NOT SET'}`);
  console.log(`  • GOOGLE_PUBSUB_SUBSCRIPTION:    ${subName || 'NOT SET'}`);
  console.log(`  • GOOGLE_PUBSUB_TOPIC:           ${topicName || 'NOT SET'}`);
  console.log(`  • GMAIL_ACCOUNT_EMAIL:           ${userMailbox}`);

  if (credPath) {
    if (fs.existsSync(credPath)) {
      console.log(`  -> Credentials file exists at: ${credPath} (OK)`);
      try {
        const rawJson = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
        const credType = rawJson.type || (rawJson.installed ? 'oauth_client' : 'unknown');
        const principal = rawJson.client_email || rawJson.client_id || 'unknown';
        console.log(`  • Authenticating as:  ${principal}`);
        console.log(`  • Credential Type:    ${credType}`);

        if (credType === 'service_account' && principal !== userMailbox) {
          console.log(`\n  ⚠️  KEY INSIGHT / IDENTITY MISMATCH:`);
          console.log(`     The script authenticates to Google Cloud as the Service Account:`);
          console.log(`       👉 ${principal}`);
          console.log(`     If you granted permissions to "${userMailbox}", Google Cloud rejects this`);
          console.log(`     because the request comes from "${principal}".`);
          console.log(`     👉 Add the Pub/Sub Subscriber role to "${principal}" in Google Cloud IAM!\n`);
        }
      } catch (e: any) {
        console.log(`  -> Could not parse credentials json: ${e.message}`);
      }
    } else {
      console.error(`  -> ⚠️ ERROR: File not found at path: ${credPath}`);
    }
  }

  // Test Google Cloud Pub/Sub and Gmail API
  try {
    const { google } = await import('googleapis');
    const { PubSub } = await import('@google-cloud/pubsub');

    console.log('\n[2. Google Cloud Pub/Sub Connection & Subscription Status]');
    try {
      const pubsub = new PubSub();
      if (subName) {
        const subscription = pubsub.subscription(subName);
        const [exists] = await subscription.exists();
        console.log(`  • Subscription "${subName}" exists: ${exists ? 'YES (OK)' : 'NO (NOT FOUND)'}`);

        if (exists) {
          const [metadata] = await subscription.getMetadata();
          console.log(`  • Linked Topic: ${metadata.topic}`);
          console.log(`  • Push/Pull Config: ${metadata.pushConfig?.pushEndpoint ? 'Push' : 'Pull (StreamingPull)'}`);
          console.log(`  • Ack Deadline: ${metadata.ackDeadlineSeconds}s`);
        }
      }
    } catch (pubsubErr: any) {
      console.error(`  • ⚠️ Pub/Sub Error: ${pubsubErr.message}`);
      if (pubsubErr.message.includes('PERMISSION_DENIED')) {
        console.log(`\n  👉 HOW TO FIX IN GOOGLE CLOUD CONSOLE:`);
        console.log(`     1. Go to Google Cloud Console (project: bfmr-automation)`);
        console.log(`     2. Go to "IAM & Admin" -> "IAM"`);
        console.log(`     3. Find your Service Account email (from gcp-credentials.json)`);
        console.log(`     4. Edit Principal -> Add Role: "Pub/Sub Subscriber" and "Pub/Sub Viewer"`);
        console.log(`     5. Also ensure topic "gmail-notifications" grants "Pub/Sub Publisher" to:`);
        console.log(`        gmail-api-push@system.gserviceaccount.com\n`);
      }
    }

    // Step 2b: Test IMAP as direct alternative
    const imapPass = process.env.GMAIL_APP_PASSWORD;
    if (imapPass) {
      console.log('\n[2b. Direct Gmail IMAP Check]');
      try {
        const { ImapFlow } = await import('imapflow');
        const client = new ImapFlow({
          host: 'imap.gmail.com',
          port: 993,
          secure: true,
          auth: { user: userMailbox, pass: imapPass },
          logger: false,
        });
        await client.connect();
        console.log(`  • IMAP Connection: SUCCESSFUL (connected as ${userMailbox})`);
        const lock = await client.getMailboxLock('INBOX');
        try {
          const status = await client.status('INBOX', { messages: true, unseen: true });
          if (!status) throw new Error('IMAP status read failed');
          console.log(`  • INBOX status: ${status.messages} total, ${status.unseen} unread.`);
        } finally {
          lock.release();
          await client.logout();
        }
      } catch (imapErr: any) {
        console.error(`  • IMAP Error: ${imapErr.message}`);
      }
    }

    console.log('\n[3. Gmail API & Watch Status]');
    const auth = new google.auth.GoogleAuth({
      scopes: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.modify',
      ],
    });
    const gmail = google.gmail({ version: 'v1', auth });

    // Step 3a: Try to list latest messages in inbox
    console.log(`  • Querying Gmail inbox for ${userMailbox}...`);
    try {
      const listRes = await gmail.users.messages.list({
        userId: userMailbox,
        maxResults: 5,
        q: 'label:INBOX',
      });

      const msgs = listRes.data.messages || [];
      console.log(`  -> Found ${msgs.length} recent message(s) in INBOX.`);

      if (msgs.length > 0) {
        console.log('\n[4. Recent Messages in Inbox & Parsing Test]');
        for (const m of msgs.slice(0, 3)) {
          const detail = await gmail.users.messages.get({
            userId: userMailbox,
            id: m.id!,
            format: 'full',
          });
          const headers = detail.data.payload?.headers || [];
          const from = headers.find((h: any) => h.name.toLowerCase() === 'from')?.value || 'Unknown';
          const subject = headers.find((h: any) => h.name.toLowerCase() === 'subject')?.value || 'No Subject';
          const date = headers.find((h: any) => h.name.toLowerCase() === 'date')?.value || '';

          console.log(`\n  • Message ID: ${m.id}`);
          console.log(`    Date:    ${date}`);
          console.log(`    From:    ${from}`);
          console.log(`    Subject: ${subject}`);

          // Extract body
          let bodyText = '';
          const extract = (part: any) => {
            if (part.body?.data) {
              bodyText += Buffer.from(part.body.data, 'base64').toString('utf-8') + '\n';
            }
            if (part.parts) part.parts.forEach(extract);
          };
          if (detail.data.payload) extract(detail.data.payload);

          // Run parser
          const parsed = parseIncomingEmail({
            messageId: m.id!,
            sender: from,
            subject,
            body: bodyText || detail.data.snippet || '',
          });

          console.log(`    -> Classification: ${parsed.isSingleDeal ? 'QUALIFYING DEAL' : 'DISQUALIFIED'}`);
          if (parsed.canonicalDealId) {
            console.log(`    -> Canonical Deal ID: ${parsed.canonicalDealId}`);
            console.log(`    -> Retailer: ${parsed.retailer} | Bundle: ${parsed.isBundle}`);
          }
        }
      }
    } catch (listErr: any) {
      console.error(`  -> ⚠️ Gmail API list error: ${listErr.message}`);
      if (listErr.message.includes('unauthorized_client') || listErr.message.includes('access_denied')) {
        console.log(`     Note: Service accounts cannot read a personal @gmail.com inbox without OAuth2 user credentials or Google App Password.`);
      }
    }

    // Step 3b: Inspect / Renew Gmail Watch
    if (topicName) {
      console.log(`\n[5. Gmail Watch Renewal Check]`);
      console.log(`  • Attempting to renew Gmail watch on topic: ${topicName}...`);
      try {
        const watchRes = await gmail.users.watch({
          userId: userMailbox,
          requestBody: {
            topicName,
            labelIds: ['INBOX'],
          },
        });
        console.log('  -> Watch successfully established!');
        console.log(`     historyId: ${watchRes.data.historyId}`);
        console.log(`     expiration: ${new Date(parseInt(watchRes.data.expiration!, 10)).toLocaleString()}`);
      } catch (watchErr: any) {
        console.error(`  -> ⚠️ Watch registration failed: ${watchErr.message}`);
        console.log(`\n     Common causes:`);
        console.log(`     1. The Pub/Sub topic must grant the "Pub/Sub Publisher" role to:`);
        console.log(`        gmail-api-push@system.gserviceaccount.com`);
        console.log(`     2. In Google Cloud Console -> Pub/Sub -> Topics -> ${topicName} -> Permissions -> Add Principal.`);
      }
    }
  } catch (err: any) {
    console.error('Fatal diagnostic error:', err.message);
  }

  console.log('\n' + '='.repeat(80));
  console.log('DIAGNOSTIC COMPLETE');
  console.log('='.repeat(80) + '\n');
}

debugGmailIntake().catch(console.error);
