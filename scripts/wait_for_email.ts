import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { parseBfmrEmail as parseIncomingEmail } from '../src/services/bfmrEmailLinks';

const PORT = process.env.INBOUND_PORT ? parseInt(process.env.INBOUND_PORT, 10) : 3005;
const DROP_DIR = path.resolve(process.cwd(), 'inbox_drop');

// Ensure drop directory exists
if (!fs.existsSync(DROP_DIR)) {
  fs.mkdirSync(DROP_DIR, { recursive: true });
}

console.log('='.repeat(80));
console.log('BFMR AUTOMATION v2 — INCOMING EMAIL LISTENER & PARSER TEST');
console.log('Authoritative Baseline: Solution Design Specification v1.5');
console.log('='.repeat(80));
console.log(`\nWaiting for incoming BFMR email...`);
console.log(`\nYou can deliver an email to this listener in either of two ways:`);
console.log(`1. HTTP POST raw email JSON or body to: http://127.0.0.1:${PORT}/email`);
console.log(`   Example:`);
console.log(`   curl -X POST http://127.0.0.1:${PORT}/email \\`);
console.log(`     -H "Content-Type: application/json" \\`);
console.log(`     -d '{"subject":"New Deal: Sony WH-1000XM5","sender":"deals@buyformeretail.com","body":"Link: https://www.buyformeretail.com/deals/sony-xm5\\nPayout: $330\\nRetailer: Amazon"}'`);
console.log(`\n2. Drop a text or .eml file into folder: ${DROP_DIR}/`);

function processEmail(raw: {
  subject: string;
  sender?: string;
  body: string;
  source: string;
}) {
  const sender = raw.sender || 'deals@buyformeretail.com';
  const parsed = parseIncomingEmail({
    messageId: `<msg-live-${Date.now()}@buyformeretail.com>`,
    sender,
    subject: raw.subject,
    body: raw.body,
  });

  console.log('\n' + '='.repeat(80));
  console.log(`[EMAIL RECEIVED via ${raw.source}] at ${new Date().toISOString()}`);
  console.log(`From:    ${sender}`);
  console.log(`Subject: ${raw.subject}`);
  console.log('-'.repeat(80));
  console.log('PARSED DEALS & ATTRIBUTES:');
  console.log(`  • Single Deal:        ${parsed.isSingleDeal ? 'YES (Qualifying)' : 'NO (Disqualified)'}`);
  console.log(`  • Multi-Deal:         ${parsed.isMultiDeal ? 'YES (Ignored per v1.5)' : 'NO'}`);
  console.log(`  • Additional Slots:   ${parsed.isAdditionalSlotNotice ? 'YES (Ignored per v1.5)' : 'NO'}`);
  console.log(`  • Canonical Deal ID:  ${parsed.canonicalDealId || 'NONE / NOT FOUND'}`);
  console.log(`  • Deal Title:         ${parsed.dealTitle}`);
  console.log(`  • Retailer:           ${parsed.retailer}`);
  console.log(`  • Bundle Offer:       ${parsed.isBundle ? 'YES (Quantity 1 for bundle)' : 'NO'}`);
  console.log(`  • Quantity Rule:      1 offer (Locked MVP 1 rule)`);
  console.log(`  • Payout Price:       ${parsed.payoutPrice ? `$${parsed.payoutPrice}` : 'Not specified'}`);
  console.log(`  • Retail Price:       ${parsed.retailPrice ? `$${parsed.retailPrice}` : 'Not specified'}`);
  console.log(`  • Trusted URL:        ${parsed.dealUrl || 'None (Must match buyformeretail.com)'}`);
  console.log('-'.repeat(80));

  if (parsed.isSingleDeal && parsed.canonicalDealId) {
    console.log('RESULT: QUALIFIES FOR AUTOMATION PIPELINE');
    console.log(`-> Next Step: Query My Tracker for active reservation of "${parsed.canonicalDealId}"`);
  } else if (parsed.isMultiDeal) {
    console.log('RESULT: DISQUALIFIED — Multiple-deal digests are excluded from MVP 1.');
  } else if (parsed.isAdditionalSlotNotice) {
    console.log('RESULT: DISQUALIFIED — Additional-slot notices are excluded from MVP 1.');
  } else {
    console.log('RESULT: DISQUALIFIED — Missing trusted BFMR deal link or invalid single deal syntax.');
  }
  console.log('='.repeat(80) + '\n');
  console.log('Waiting for next incoming email...\n');
}

// 1. HTTP Server
const server = http.createServer((req, res) => {
  if (req.method === 'POST') {
    let bodyStr = '';
    req.on('data', (chunk) => {
      bodyStr += chunk;
    });
    req.on('end', () => {
      try {
        let payload: any;
        if (req.headers['content-type']?.includes('application/json')) {
          payload = JSON.parse(bodyStr);
        } else {
          // Plain text format: first line subject, rest body
          const lines = bodyStr.split('\n');
          const subject = lines[0] || 'Unknown Subject';
          const body = lines.slice(1).join('\n');
          payload = { subject, body };
        }

        processEmail({
          subject: payload.subject || 'No Subject',
          sender: payload.sender || payload.from || 'deals@buyformeretail.com',
          body: payload.body || payload.text || '',
          source: 'HTTP POST',
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'OK', message: 'Email parsed successfully' }));
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('BFMR Inbound Email Listener Active. POST your email payload to /email.\n');
  }
});

let currentPort = PORT;

server.on('error', (err: any) => {
  if (err.code === 'EADDRINUSE') {
    currentPort++;
    server.listen(currentPort, '127.0.0.1');
  } else {
    console.error('Server error:', err);
  }
});

server.listen(currentPort, '127.0.0.1', () => {
  console.log(`\nHTTP receiver ready on http://127.0.0.1:${currentPort}/email`);
  console.log(`Folder watcher ready on ${DROP_DIR}/\n`);
  console.log('Listening now... (Press Ctrl+C to exit)\n');
});

// 2. Directory File Watcher
fs.watch(DROP_DIR, (eventType, filename) => {
  if (filename && eventType === 'rename') {
    const filePath = path.join(DROP_DIR, filename);
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        // Parse simple email format (Subject: ... on first line, or JSON)
        let subject = '';
        let body = '';
        let sender = 'deals@buyformeretail.com';

        if (content.trim().startsWith('{')) {
          const json = JSON.parse(content);
          subject = json.subject || 'No Subject';
          body = json.body || '';
          sender = json.sender || sender;
        } else {
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.toLowerCase().startsWith('subject:')) {
              subject = line.substring(8).trim();
            } else if (line.toLowerCase().startsWith('from:')) {
              sender = line.substring(5).trim();
            } else if (line.trim() === '' && !body) {
              body = lines.slice(i + 1).join('\n');
              break;
            }
          }
          if (!subject && lines.length > 0) {
            subject = lines[0];
            body = lines.slice(1).join('\n');
          }
        }

        processEmail({
          subject,
          sender,
          body,
          source: `File Drop (${filename})`,
        });

        // Clean up or rename processed file
        fs.unlinkSync(filePath);
      } catch (e: any) {
        console.error(`Error processing dropped file ${filename}:`, e.message);
      }
    }
  }
});
