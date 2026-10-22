import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

// These suites must never fall through to a configured database or provider.
// Filesystem reads (including PGlite's local WASM assets) remain available.
const deny = (): never => { throw new Error('OFFLINE_TEST_NETWORK_FORBIDDEN'); };
net.Socket.prototype.connect = deny;
tls.connect = deny;
http.request = deny;
http.get = deny;
https.request = deny;
https.get = deny;
syncBuiltinESMExports();

for (const name of Object.keys(process.env)) {
  if (/^(BFMR_|GMAIL_|GOOGLE_|TELEGRAM_|AMAZON_)/.test(name)
      || ['DATABASE_URL', 'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'].includes(name)) {
    delete process.env[name];
  }
}
