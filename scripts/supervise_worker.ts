import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface SupervisorConfig {
  workerScript: string;
  heartbeatPath: string;
  initialDelayMs: number;
  maxDelayMs: number;
  maxBurstCrashes: number;
  burstWindowMs: number;
  shutdownTimeoutMs: number;
}

export function getDefaultSupervisorConfig(): SupervisorConfig {
  return {
    workerScript: path.resolve('scripts/run_bfmr.ts'),
    heartbeatPath: process.env.BFMR_HEARTBEAT_PATH || path.join(os.tmpdir(), 'bfmr-worker-heartbeat.json'),
    initialDelayMs: 5000,
    maxDelayMs: 60000,
    maxBurstCrashes: 5,
    burstWindowMs: 300000, // 5 minutes
    shutdownTimeoutMs: 25000,
  };
}

export class WorkerSupervisor {
  private child: ChildProcess | null = null;
  private isShuttingDown = false;
  private restartDelay: number;
  private crashTimestamps: number[] = [];
  private totalRestarts = 0;
  private config: SupervisorConfig;
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor(config: SupervisorConfig = getDefaultSupervisorConfig()) {
    this.config = config;
    this.restartDelay = config.initialDelayMs;
  }

  public writeHeartbeat(status: 'RUNNING' | 'STARTING' | 'STOPPED' | 'DEGRADED', error?: string): void {
    try {
      const data = {
        pid: this.child?.pid ?? process.pid,
        supervisorPid: process.pid,
        status,
        timestamp: new Date().toISOString(),
        totalRestarts: this.totalRestarts,
        error: error ?? null,
      };
      fs.writeFileSync(this.config.heartbeatPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      // Ignore heartbeat write errors
    }
  }

  public static reapOrphanBrowserProcesses(): void {
    try {
      if (process.platform !== 'win32') {
        const { execSync } = require('node:child_process');
        execSync('pkill -f "playwright.*chrome|chrome.*--headless" 2>/dev/null || true', { stdio: 'ignore' });
      }
    } catch {
      // Non-fatal process sweep
    }
  }

  public async start(): Promise<void> {
    console.log(`[Supervisor] Starting BFMR Automation v2 Supervisor (PID: ${process.pid})...`);
    WorkerSupervisor.reapOrphanBrowserProcesses();
    this.setupSignals();
    this.writeHeartbeat('STARTING');

    this.heartbeatInterval = setInterval(() => {
      if (this.child && !this.isShuttingDown) {
        this.writeHeartbeat('RUNNING');
      }
    }, 15000);

    await this.spawnLoop();
  }

  private setupSignals(): void {
    const handleSignal = async (sig: NodeJS.Signals) => {
      console.log(`\n[Supervisor] Received ${sig}; initiating graceful worker shutdown...`);
      this.isShuttingDown = true;
      if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
      this.writeHeartbeat('STOPPED');

      if (this.child) {
        this.child.kill('SIGTERM');
        const timeout = setTimeout(() => {
          if (this.child) {
            console.error('[Supervisor] Graceful shutdown timed out; force-killing worker (SIGKILL)...');
            this.child.kill('SIGKILL');
          }
        }, this.config.shutdownTimeoutMs);

        this.child.on('exit', () => {
          clearTimeout(timeout);
          console.log('[Supervisor] Worker exited cleanly. Supervisor shutting down.');
          process.exit(0);
        });
      } else {
        process.exit(0);
      }
    };

    process.on('SIGINT', handleSignal);
    process.on('SIGTERM', handleSignal);
  }

  private pruneCrashTimestamps(): void {
    const now = Date.now();
    this.crashTimestamps = this.crashTimestamps.filter(t => now - t <= this.config.burstWindowMs);
  }

  private async spawnLoop(): Promise<void> {
    while (!this.isShuttingDown) {
      this.pruneCrashTimestamps();
      if (this.crashTimestamps.length >= this.config.maxBurstCrashes) {
        console.error(`[Supervisor] FATAL: Worker crashed ${this.crashTimestamps.length} times in ${this.config.burstWindowMs / 1000}s.`);
        console.error('[Supervisor] Halting supervisor to protect account state. Inspect logs and database state.');
        this.writeHeartbeat('DEGRADED', 'Exceeded maximum crash burst rate');
        process.exit(1);
      }

      console.log(`[Supervisor] Launching worker: node --import tsx ${this.config.workerScript}`);
      const startTime = Date.now();

      try {
        const exitCode = await this.runWorkerOnce();
        if (this.isShuttingDown) break;

        const runDuration = Date.now() - startTime;
        if (runDuration > 60000) {
          // If the worker ran successfully for more than 1 minute, reset backoff delay
          this.restartDelay = this.config.initialDelayMs;
        }

        if (exitCode === 0) {
          console.log('[Supervisor] Worker completed with exit code 0.');
          break;
        } else {
          this.handleWorkerCrash(exitCode);
          await this.delay(this.restartDelay);
          this.restartDelay = Math.min(this.restartDelay * 2, this.config.maxDelayMs);
        }
      } catch (err: any) {
        if (this.isShuttingDown) break;
        console.error(`[Supervisor] Worker process error: ${err.message}`);
        this.handleWorkerCrash(1);
        await this.delay(this.restartDelay);
        this.restartDelay = Math.min(this.restartDelay * 2, this.config.maxDelayMs);
      }
    }
  }

  private runWorkerOnce(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.child = spawn('node', ['--import', 'tsx', this.config.workerScript], {
        stdio: 'inherit',
        env: { ...process.env },
      });

      this.writeHeartbeat('RUNNING');

      this.child.on('error', (err) => {
        reject(err);
      });

      this.child.on('exit', (code, signal) => {
        this.child = null;
        if (signal) {
          console.warn(`[Supervisor] Worker was terminated by signal: ${signal}`);
          resolve(128 + 15);
        } else {
          resolve(code ?? 0);
        }
      });
    });
  }

  private handleWorkerCrash(code: number): void {
    this.totalRestarts++;
    this.crashTimestamps.push(Date.now());
    console.error(`[Supervisor] Worker crashed with code ${code}. Total restarts: ${this.totalRestarts}.`);
    console.log(`[Supervisor] Backing off for ${this.restartDelay / 1000}s before next restart...`);
    this.writeHeartbeat('DEGRADED', `Worker exited with code ${code}`);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Direct execution
if (import.meta.url === `file://${process.argv[1]}` || (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('scripts/supervise_worker.ts'))) {
  const supervisor = new WorkerSupervisor();
  supervisor.start().catch(err => {
    console.error(`[Supervisor] Fatal error: ${err.message}`);
    process.exit(1);
  });
}
