import { sourceIdentity } from './sourceIdentity';
import { assertIntakePrivileges, IntakePrivilegeError } from '../src/db/intakePrivileges';
import './loadEnv';
import { readFile, open, stat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isAbsolute, dirname, resolve } from 'node:path';
import { PlaywrightBfmrBrowser } from '../src/adapters/playwrightBrowser';
import { openRelationalRuntime } from '../src/services/relationalRuntime';
import { DealEmailWorkflowStore, canonicalWorkflowJson, LegacyWorkflowSnapshotError } from '../src/services/dealEmailWorkflowStore';
import { reconcileDealEmail, applyDealEmailReconciliation, type EmailReconciliationReport } from '../src/services/dealEmailReconciliation';
import { readRecentReservedRows } from '../src/services/bfmrTrackerApi';
import { verifyBfmrAccountIdentity } from '../src/services/bfmrAccountIdentity';
import { isTrustedBfmrHost } from '../src/services/bfmrUrl';

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node --import tsx scripts/reconcile_deal_email.ts --message-id <private Gmail ID> --browser-pid <existing Chromium PID> --report-file <private absolute path>');
    console.log('Default: provider/SQL read-only report. Never submits/cancels/reserves/orders or sends notifications.');
    console.log('Reviewed local repair additionally requires --apply --confirm-report-sha256 <exact reviewed report hash>.');
    console.log('Stop the worker first. Unknown outcomes cannot be repaired by this command. No Gmail cursor reset or completed-message replay.');
    return;
  }
  const values = new Map<string, string>();
  let apply = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply' && !apply) { apply = true; continue; }
    if (!['--message-id', '--browser-pid', '--report-file', '--confirm-report-sha256'].includes(args[i]) ||
        values.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid reconciliation arguments.');
    values.set(args[i], args[++i]);
  }
  const id = values.get('--message-id');
  const file = values.get('--report-file');
  const pid = values.get('--browser-pid');
  if (!id || !file || !isAbsolute(file) || !pid || !/^[1-9]\d*$/.test(pid) || Number(pid) < 2) throw new Error('Exact message, existing browser PID and private report path are required.');
  const directoryPath = await realpath(dirname(file));
  const repository = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  if (directoryPath === repository || directoryPath.startsWith(repository + '/')) throw new Error('Private reports must be outside the repository.');
  const directory = await stat(directoryPath);
  if (resolve(file) !== resolve(directoryPath, file.slice(file.lastIndexOf('/') + 1))) throw new Error('Report directory symlinks require an explicit canonical path.');
  if (!directory.isDirectory() || (directory.mode & 0o077) !== 0) throw new Error('Report directory must already exist with owner-only permissions.');
  let reviewed: (EmailReconciliationReport & { source: ReturnType<typeof sourceIdentity> }) | undefined;
  let reviewedHash: string | undefined;
  if (apply) {
    const info = await stat(file);
    if (!info.isFile() || info.mode & 0o077) throw new Error('Reviewed report must have owner-only permissions.');
    const bytes = await readFile(file);
    reviewedHash = createHash('sha256').update(bytes).digest('hex');
    if (reviewedHash !== values.get('--confirm-report-sha256')) throw new Error('Exact reviewed report hash is required.');
    reviewed = JSON.parse(bytes.toString('utf8')) as EmailReconciliationReport & { source: ReturnType<typeof sourceIdentity> };
    if (!reviewed.ready) throw new Error('Report is not ready; regenerate/review it.');
  } else if (values.has('--confirm-report-sha256')) throw new Error('Confirmation hash is valid only with --apply.');

  const source = sourceIdentity();
  if (apply && (!reviewed?.source || canonicalWorkflowJson(reviewed.source) !== canonicalWorkflowJson(source))) {
    throw new Error('Source revision/content differs from the reviewed report; regenerate/review it.');
  }
  const runtime = await openRelationalRuntime();
  const browser = new PlaywrightBfmrBrowser({ browserPid: Number(pid) });
  runtime.ownership.onOwnershipLost(() => { void browser.close(); });
  try {
    const store = new DealEmailWorkflowStore(runtime.db, runtime.account);
    if (apply && reviewed && reviewedHash && reviewed.next.messageId === id &&
        await store.repairAlreadyApplied(reviewed.next, reviewedHash)) {
      console.log(JSON.stringify({ mode: 'ALREADY_APPLIED', reportSha256: reviewedHash }));
      return;
    }
    if (apply && reviewed) {
      const age = Date.now() - Date.parse(reviewed.generatedAt);
      if (!Number.isFinite(age) || age < 0 || age > 5 * 60_000) throw new Error('Report is not fresh; regenerate/review it.');
    }
    await runtime.db.withTransaction(tx => assertIntakePrivileges(tx));
    const checkpoint = await store.loadForReconciliation(id);
    if (!checkpoint) throw new Error('No durable workflow exists; historical messages cannot be enrolled by repair.');
    const page = await browser.init();
    const bfmr = page.context().pages().find(candidate => {
      try { return isTrustedBfmrHost(new URL(candidate.url()).hostname); } catch { return false; }
    });
    if (!bfmr || !await verifyBfmrAccountIdentity(bfmr, runtime.account)) throw new Error('Verified BFMR browser/API alignment is required.');
    const report = { ...await reconcileDealEmail(runtime, checkpoint, { readTracker: readRecentReservedRows,
      createRetailerPage: () => browser.createRetailerTab() }), source };
    if (apply) {
      const stable = (r: EmailReconciliationReport) => { const { generatedAt: _observed, ...rest } = r; return canonicalWorkflowJson(rest); };
      if (!reviewed || stable(reviewed) !== stable(report)) throw new Error('Fresh provider evidence/state differs from the reviewed plan.');
      await applyDealEmailReconciliation(runtime, checkpoint, report, reviewedHash!);
      console.log(JSON.stringify({ mode: 'APPLIED', reportSha256: reviewedHash, status: report.next.status }));
    } else {
      const handle = await open(file, 'wx', 0o600);
      const content = JSON.stringify(report, null, 2) + '\n';
      try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
      console.log(JSON.stringify({ mode: 'REPORT', ready: report.ready, reportSha256: createHash('sha256').update(content).digest('hex'),
        issues: report.issues }));
      if (!report.ready) process.exitCode = 1;
    }
  } finally { try { await browser.close(); } finally { await runtime.close(); } }
}
main().catch(error => {
  if (error instanceof IntakePrivilegeError || error instanceof LegacyWorkflowSnapshotError) console.error(error.message);
  else if (typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)) console.error(`Database reconciliation failed (${error.code}).`);
  console.error('Workflow reconciliation stopped. Preserve the private report and exact provider evidence; no external action was retried.');
  process.exitCode = 1;
});
