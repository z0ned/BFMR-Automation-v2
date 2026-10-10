/** The application owns the browser; individual emails never close it. */
export async function runBrowserSession<T>(
  browser: { init(): Promise<unknown>; close(): Promise<void> },
  emails: AsyncIterable<T>,
  processEmail: (email: T) => Promise<void>,
  waitForExitAfterFailure: (error: unknown) => Promise<void>,
  beforeProcessing: () => Promise<void> = async () => {},
): Promise<void> {
  try {
    await browser.init();
    await beforeProcessing();
    for await (const email of emails) await processEmail(email);
  } catch (error) {
    // Preserve the page for manual inspection; do not advance or replay work.
    await waitForExitAfterFailure(error);
  } finally {
    await browser.close();
  }
}
