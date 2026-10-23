import './loadEnv';
import http from 'node:http';
import fs from 'node:fs';
import { google } from 'googleapis';

const clientId = process.env.GMAIL_CLIENT_ID;
const clientSecret = process.env.GMAIL_CLIENT_SECRET;
const expectedMailbox = process.env.GMAIL_ACCOUNT_EMAIL?.trim().toLowerCase();
if (!clientId || !clientSecret || !expectedMailbox) throw new Error('Configure the selected environment Gmail client and mailbox first.');
const port = process.env.BFMR_INTAKE_MODE === 'testing' ? 3009 : 3008;
const oauth = new google.auth.OAuth2(clientId, clientSecret, `http://127.0.0.1:${port}/oauth2callback`);
const { randomBytes } = await import('node:crypto');
const state = randomBytes(32).toString('hex');
const url = oauth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', state,
  scope: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.modify'] });
const server = http.createServer(async (request, response) => {
  const callback = new URL(request.url || '/', `http://127.0.0.1:${port}`);
  if (callback.pathname !== '/oauth2callback' || callback.searchParams.get('state') !== state || !callback.searchParams.get('code')) {
    response.writeHead(400); response.end('Invalid OAuth callback.'); return;
  }
  try {
    const { tokens } = await oauth.getToken(callback.searchParams.get('code')!);
    oauth.setCredentials(tokens);
    const profile = await google.gmail({ version: 'v1', auth: oauth }).users.getProfile({ userId: 'me' });
    if (profile.data.emailAddress?.trim().toLowerCase() !== expectedMailbox) throw new Error('Wrong mailbox.');
    if (!tokens.refresh_token) throw new Error('No refresh token returned.');
    const file = process.env.BFMR_ENV_FILE!;
    const key = process.env.BFMR_INTAKE_MODE === 'testing' ? 'GMAIL_REFRESH_TOKEN_TEST' : 'GMAIL_REFRESH_TOKEN_PRODUCTION';
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const content = existing.split('\n').filter(line => !new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(line)).join('\n');
    fs.writeFileSync(file, `${content}\n${key}=${tokens.refresh_token}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    response.writeHead(200); response.end('Gmail authorization saved. You can close this window.');
    console.log('Saved the selected environment token after verifying its mailbox. No Gmail watch was changed.');
  } catch {
    response.writeHead(400); response.end('Authorization failed. Check the selected mailbox and client configuration.');
    console.error('Gmail authorization failed; private provider details omitted.');
    process.exitCode = 1;
  } finally { server.close(); }
});
server.listen(port, '127.0.0.1', () => console.log(`Open this authorization link in your browser:\n${url}`));
