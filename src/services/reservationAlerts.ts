/** Server-side Telegram failure reporting for live test runners. */
export function requireReservationAlerts(env: NodeJS.ProcessEnv = process.env): { token: string; chatId: string } {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required for reservation failure alerts.');
  return { token, chatId };
}

export async function sendReservationFailureAlert(context: string, request: typeof fetch = fetch): Promise<void> {
  const { token, chatId } = requireReservationAlerts();
  try {
    const response = await request(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `BFMR reservation failed or could not be confirmed.\n${context.slice(0, 1000)}\nReview My Tracker and the app terminal before retrying.`,
        link_preview_options: { is_disabled: true },
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json() as { ok?: boolean; result?: { message_id?: number } };
    if (!response.ok || payload.ok !== true || !Number.isInteger(payload.result?.message_id)) {
      throw new Error('Telegram rejected the alert.');
    }
  } catch {
    // Fetch errors can contain the token-bearing URL; never propagate them.
    throw new Error('Telegram reservation failure alert was not delivered. Inspect notification configuration/connectivity.');
  }
}

export async function withReservationFailureAlert<T>(context: string, action: () => Promise<T>, notify = sendReservationFailureAlert): Promise<T> {
  try { return await action(); }
  catch (error) {
    try { await notify(context); console.log('[Telegram] Reservation failure alert delivered.'); }
    catch { console.error('[Telegram] ALERT DELIVERY FAILED. Processing remains stopped; check notification configuration/connectivity.'); }
    throw error;
  }
}
