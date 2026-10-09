import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';

// Load .env
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  try {
    process.loadEnvFile();
  } catch {}
}

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const TOPIC_NAME = process.env.GOOGLE_PUBSUB_TOPIC || 'projects/bfmr-automation/topics/gmail-notifications';
const PORT = 3008;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/oauth2callback`;

console.log('='.repeat(80));
console.log('BFMR AUTOMATION v2 — GMAIL OAUTH REFRESH TOKEN GENERATOR');
console.log('Authoritative Baseline: Solution Design Specification v1.5 (Page 14)');
console.log('='.repeat(80));

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('\n❌ ERROR: GMAIL_CLIENT_ID or GMAIL_CLIENT_SECRET is missing from your .env file!');
  console.log('\nPlease add them to /home/wardmatt/bfmr-automation/BFMR-Automation-Codex/.env:');
  console.log('  GMAIL_CLIENT_ID=your-client-id.apps.googleusercontent.com');
  console.log('  GMAIL_CLIENT_SECRET=GOCSPX-your-client-secret\n');
  console.log('How to get them (takes 60 seconds):');
  console.log('1. Go to https://console.cloud.google.com/apis/credentials?project=bfmr-automation');
  console.log('2. Click "+ CREATE CREDENTIALS" -> "OAuth client ID"');
  console.log('3. Application type: "Desktop app" (or "Web application" with redirect URI http://127.0.0.1:3008/oauth2callback)');
  console.log('4. Copy the Client ID and Client Secret into your .env file.\n');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
];

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline', // Generates a permanent refresh_token
  prompt: 'consent',     // Forces consent prompt so refresh_token is always returned
  scope: SCOPES,
});

console.log('\n👉 STEP 1: Open this authorization link in your web browser:\n');
console.log(authUrl);
console.log('\n👉 STEP 2: Log in with: mbw.price.monitor.agent@gmail.com and click "Allow".');
console.log(`\nWaiting for browser authorization callback on port ${PORT}... (Press Ctrl+C to cancel)\n`);

const server = http.createServer(async (req, res) => {
  if (req.url?.startsWith('/oauth2callback')) {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`<h2>Authorization Error:</h2><p>${error}</p>`);
      console.error(`\n❌ Authorization failed: ${error}`);
      server.close();
      process.exit(1);
    }

    if (code) {
      try {
        console.log('[OAuth] Authorization code received! Exchanging for permanent refresh token...');
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        const refreshToken = tokens.refresh_token;

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <div style="font-family: sans-serif; text-align: center; padding: 40px;">
            <h1 style="color: #16a34a;">✅ Gmail Authorization Successful!</h1>
            <p>Your permanent refresh token has been created and saved.</p>
            <p>You can close this window and return to your terminal.</p>
          </div>
        `);

        console.log('\n' + '='.repeat(80));
        console.log('✅ GMAIL REFRESH TOKEN RECEIVED SUCCESSFULLY!');
        console.log('='.repeat(80));

        // Save to .env
        if (refreshToken) {
          console.log(`\nRefresh Token: ${refreshToken.slice(0, 15)}... (Redacted for security)`);

          let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
          if (envContent.includes('GMAIL_REFRESH_TOKEN=')) {
            envContent = envContent.replace(/GMAIL_REFRESH_TOKEN=.*/, `GMAIL_REFRESH_TOKEN=${refreshToken}`);
          } else {
            envContent += `\nGMAIL_REFRESH_TOKEN=${refreshToken}\n`;
          }
          fs.writeFileSync(envPath, envContent, 'utf-8');
          console.log(`-> Saved GMAIL_REFRESH_TOKEN directly to your local .env file!`);

          // Also save backup to ~/.bfmr/gmail_token.json
          const bfmrDir = path.resolve(process.env.HOME || '/home/wardmatt', '.bfmr');
          if (!fs.existsSync(bfmrDir)) fs.mkdirSync(bfmrDir, { recursive: true });
          const tokenFile = path.join(bfmrDir, 'gmail_token.json');
          fs.writeFileSync(tokenFile, JSON.stringify(tokens, null, 2), { mode: 0o600 });
          console.log(`-> Saved token to ${tokenFile} (chmod 600)`);
        } else {
          console.log('ℹ️ Note: Refresh token was already granted previously.');
        }

        // Test calling Gmail Watch immediately
        console.log('\n[Testing Gmail Watch Registration with OAuth Token]');
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        try {
          const watchRes = await gmail.users.watch({
            userId: 'me',
            requestBody: {
              topicName: TOPIC_NAME,
              labelIds: ['INBOX'],
            },
          });
          console.log(`✅ Gmail Watch successfully activated for ${TOPIC_NAME}!`);
          console.log(`   historyId:  ${watchRes.data.historyId}`);
          console.log(`   expiration: ${new Date(parseInt(watchRes.data.expiration!, 10)).toLocaleString()}`);
          console.log('\n🎉 ALL PRODUCTION GMAIL INTAKE GATES ARE NOW COMPLETE!');
          console.log('Now run: npm run test-real-email\n');
        } catch (watchErr: any) {
          console.error(`⚠️ Watch registration note: ${watchErr.message}`);
          console.log('Ensure topic "gmail-notifications" grants Pub/Sub Publisher to gmail-api-push@system.gserviceaccount.com');
        }

        setTimeout(() => {
          server.close();
          process.exit(0);
        }, 1000);
      } catch (err: any) {
        console.error('Error exchanging code for token:', err.message);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Error: ${err.message}`);
        server.close();
        process.exit(1);
      }
    }
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

server.listen(PORT, '127.0.0.1');
