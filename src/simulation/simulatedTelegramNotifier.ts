import type { ITelegramNotifier } from '../providers/interfaces';
import type { SimulatedStore } from './simulatedStore';

export class SimulatedTelegramNotifier implements ITelegramNotifier {
  constructor(
    private readonly store: SimulatedStore,
    private readonly runId: string
  ) {}

  public async sendReservationFailureAlert(context: string): Promise<void> {
    const text = `[TEST][BFMR SIMULATED][AMAZON SIMULATED]\nRun: ${this.runId}\nReservation failure / uncertainty: ${context}`;
    await this.store.logEvent(this.runId, 'ERROR', 'TELEGRAM', text);
  }

  public async sendTrackingFailureAlert(orderId: string): Promise<void> {
    const text = `[TEST][BFMR SIMULATED][AMAZON SIMULATED]\nRun: ${this.runId}\nTracking check needs review for order: ${orderId}`;
    await this.store.logEvent(this.runId, 'WARN', 'TELEGRAM', text);
  }

  public async sendCustomAlert(subject: string, body: string): Promise<void> {
    const text = `[TEST][BFMR SIMULATED][AMAZON SIMULATED]\nRun: ${this.runId}\n${subject}\n${body}`;
    await this.store.logEvent(this.runId, 'INFO', 'TELEGRAM', text);
  }
}
