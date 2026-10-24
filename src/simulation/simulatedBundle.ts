import type { ProviderBundle } from '../providers/interfaces';
import type { SimulatedStore } from './simulatedStore';
import { SimulatedBfmrApi } from './simulatedBfmrApi';
import { SimulatedBfmrBrowser } from './simulatedBfmrBrowser';
import { SimulatedAmazonProvider } from './simulatedAmazonProvider';
import { SimulatedClock } from './simulatedClock';
import { SimulatedTelegramNotifier } from './simulatedTelegramNotifier';
import type { SimulatedReservation } from './types';

export function createSimulatedProviderBundle(
  store: SimulatedStore,
  runId: string,
  options: { accountId?: string; initialTime?: Date; phase?: 1 | 2 | 3 | 4 | 5 | 6;
    purchaseStart?: 'END_TO_END' | 'SEEDED_RESERVATION'; seededReservation?: SimulatedReservation } = {}
): ProviderBundle {
  const accountId = options.accountId || 'synthetic-operator-1';
  const bfmrApi = new SimulatedBfmrApi(store, runId, accountId);
  const bfmrBrowser = new SimulatedBfmrBrowser(store, runId, accountId);
  const amazon = new SimulatedAmazonProvider(store, runId);
  const clock = new SimulatedClock(options.initialTime);
  const notifier = new SimulatedTelegramNotifier(store, runId);

  return {
    mode: 'simulation',
    intakeMode: 'testing',
    runId,
    simulationScenario: {
      phase: options.phase ?? 1,
      purchaseStart: options.purchaseStart,
      seededReservation: options.seededReservation,
    },
    simulationFaults: {
      consume: targetOp => store.checkAndTriggerFault(runId, targetOp as any),
    },
    bfmrApi,
    bfmrBrowser,
    amazon,
    clock,
    notifier,
  };
}
