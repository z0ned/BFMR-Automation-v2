import type { ProviderBundle, IBfmrApi, IBfmrBrowser, IAmazonProvider, IClock, ITelegramNotifier } from './interfaces';
import { LiveBfmrBrowser } from './live/liveBfmrBrowser';
import { LiveBfmrApi } from './live/liveBfmrApi';
import { LiveAmazonProvider } from './live/liveAmazonProvider';
import { LiveTelegramNotifier } from './live/liveTelegramNotifier';
import { SystemClock } from './live/systemClock';
import { PlaywrightBfmrBrowser } from '../adapters/playwrightBrowser';
import { intakeMode } from '../services/emailProvenance';

export * from './interfaces';
export { LiveBfmrBrowser } from './live/liveBfmrBrowser';
export { LiveBfmrApi } from './live/liveBfmrApi';
export { LiveAmazonProvider } from './live/liveAmazonProvider';
export { LiveTelegramNotifier } from './live/liveTelegramNotifier';
export { SystemClock } from './live/systemClock';

export type ProviderMode = 'live' | 'simulation';

/**
 * Validates the BFMR_PROVIDER_MODE setting against the resolved BFMR_INTAKE_MODE
 * according to Proposal Section 2.
 *
 * Rules:
 * - BFMR_PROVIDER_MODE must be explicit ('live' or 'simulation').
 * - BFMR_INTAKE_MODE=production permits only BFMR_PROVIDER_MODE=live.
 * - BFMR_INTAKE_MODE=testing permits either live or simulation.
 */
export function validateProviderMode(env: NodeJS.ProcessEnv = process.env): {
  intake: 'production' | 'testing';
  provider: ProviderMode;
} {
  const intake = intakeMode(env.BFMR_INTAKE_MODE);
  const rawProvider = env.BFMR_PROVIDER_MODE?.trim();

  if (!rawProvider) {
    // If not set, check if testing environment has specified it, otherwise error or default strictly in live
    throw new Error('BFMR_PROVIDER_MODE is required. Explicit values permitted: "live" or "simulation".');
  }

  if (rawProvider !== 'live' && rawProvider !== 'simulation') {
    throw new Error(`Unrecognized BFMR_PROVIDER_MODE: "${rawProvider}". Allowed values: "live" or "simulation".`);
  }

  if (intake === 'production' && rawProvider === 'simulation') {
    throw new Error('Invalid configuration: BFMR_INTAKE_MODE=production cannot run with BFMR_PROVIDER_MODE=simulation.');
  }

  return { intake, provider: rawProvider };
}

export interface CreateLiveBundleOptions {
  browser?: PlaywrightBfmrBrowser;
  fetchFn?: typeof fetch;
  runId?: string;
  isHeadless?: boolean;
}

/**
 * Creates an immutable ProviderBundle using live external services.
 */
export function createLiveProviderBundle(
  env: NodeJS.ProcessEnv = process.env,
  options: CreateLiveBundleOptions = {}
): ProviderBundle {
  const intake = intakeMode(env.BFMR_INTAKE_MODE);
  const browserInstance = options.browser ?? new PlaywrightBfmrBrowser({ headless: options.isHeadless });
  const bfmrBrowser: IBfmrBrowser = new LiveBfmrBrowser(browserInstance);
  const bfmrApi: IBfmrApi = new LiveBfmrApi(options.fetchFn ?? fetch);
  const amazon: IAmazonProvider = new LiveAmazonProvider();
  const clock: IClock = new SystemClock();
  const notifier: ITelegramNotifier = new LiveTelegramNotifier('live', intake, options.runId, options.fetchFn ?? fetch);

  return {
    mode: 'live',
    intakeMode: intake,
    runId: options.runId,
    bfmrApi,
    bfmrBrowser,
    amazon,
    clock,
    notifier,
  };
}

/**
 * Resolves the appropriate provider bundle based on environment variables.
 */
export function resolveProviderBundle(
  env: NodeJS.ProcessEnv = process.env,
  options: CreateLiveBundleOptions = {}
): ProviderBundle {
  const { provider } = validateProviderMode(env);

  if (provider === 'live') {
    return createLiveProviderBundle(env, options);
  }

  // Simulation mode provider bundle resolver will be wired with PGlite in Stage 2
  throw new Error('Simulation provider bundle requested but simulation harness is being initialized.');
}
