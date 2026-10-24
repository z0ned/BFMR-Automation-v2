import type { ITelegramNotifier } from '../interfaces';
import { requireReservationAlerts, sendReservationFailureAlert, sendTrackingFailureAlert } from '../../services/reservationAlerts';

/**
 * Concrete ITelegramNotifier implementation that formats context and dispatches to Telegram.
 * Formats alerts with mandatory environment and mode prefixes per Proposal Section 8.
 */
export class LiveTelegramNotifier implements ITelegramNotifier {
  constructor(
    private readonly mode: 'live' | 'simulation',
    private readonly intakeMode: 'production' | 'testing',
    private readonly runId?: string,
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  private formatMessage(text: string): string {
    const isTest = this.intakeMode === 'testing';
    const isSim = this.mode === 'simulation';
    const prefixes: string[] = [];
    if (isTest) prefixes.push('[TEST]');
    if (isSim) prefixes.push('[BFMR SIMULATED][AMAZON SIMULATED]');
    if (this.runId) prefixes.push(`[Run: ${this.runId}]`);

    if (prefixes.length > 0) {
      return `${prefixes.join('')}\n${text}`;
    }
    return text;
  }

  public async sendReservationFailureAlert(context: string): Promise<void> {
    const formatted = this.formatMessage(context);
    return sendReservationFailureAlert(formatted, this.fetchFn);
  }

  public async sendTrackingFailureAlert(orderId: string): Promise<void> {
    return sendTrackingFailureAlert(orderId, this.fetchFn);
  }

  public async sendCustomAlert(subject: string, body: string): Promise<void> {
    const { token, chatId } = requireReservationAlerts();
    if (token === 'CONSOLE_ONLY') {
      console.error(`\n[ALERT: ${subject}]\n${this.formatMessage(body)}\n`);
      return;
    }
    const response = await this.fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: this.formatMessage(`${subject}\n\n${body}`),
        link_preview_options: { is_disabled: true },
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      throw new Error(`Telegram custom alert delivery failed (HTTP ${response.status}).`);
    }
  }
}
