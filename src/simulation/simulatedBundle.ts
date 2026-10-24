import type { ProviderBundle } from '../providers/interfaces';
import type { SimulatedStore } from './simulatedStore';
import { SimulatedBfmrApi } from './simulatedBfmrApi';
import { SimulatedBfmrBrowser } from './simulatedBfmrBrowser';
import { SimulatedAmazonProvider } from './simulatedAmazonProvider';
import { SimulatedClock } from './simulatedClock';
import { SimulatedTelegramNotifier } from './simulatedTelegramNotifier';

export function createSimulatedProviderBundle(
  store: SimulatedStore,
  runId: string,
  options: { accountId?: string; initialTime?: Date } = {}
): ProviderBundle {
  const accountId = options.accountId || 'synthetic-operator-1';
  const bfmrApi = new SimulatedBfmrApi(store, runId, accountId);
  const bfmrBrowser = new SimulatedBfmrBrowser(store, runId, accountId);
  const amazon = new SimulatedAmazonProvider();
  const clock = new SimulatedClock(options.initialTime);
  const notifier = new SimulatedTelegramNotifier(store, runId);

  return {
    mode: 'simulation',
    intakeMode: 'testing',
    runId,
    bfmrApi,
    bfmrBrowser,
    amazon,
    clock,
    notifier,
  };
}
