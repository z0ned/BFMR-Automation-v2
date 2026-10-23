import { spawn } from 'node:child_process';
const [mode, script, ...args] = process.argv.slice(2);
if (!['production', 'testing'].includes(mode) || !['run_bfmr', 'supervise_worker', 'health_check', 'database_target', 'auth_bfmr', 'auth_gmail_oauth', 'diagnose_recovery', 'reconcile_deal_email'].includes(script)) {
  throw new Error('Expected an explicit environment and supported command.');
}
const child = spawn(process.execPath, ['--import', 'tsx', `scripts/${script}.ts`, ...args], {
  stdio: 'inherit', env: { ...process.env, BFMR_INTAKE_MODE: mode },
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
child.on('error', () => { console.error('Environment command could not start.'); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
