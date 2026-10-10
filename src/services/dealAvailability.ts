import type { Page } from 'playwright';

/** Only an explicit visible BFMR unavailable message proves a normal skip. */
export async function hasVisibleDealUnavailableMessage(page: Page): Promise<boolean> {
  return (await getVisibleDealUnavailableReason(page)) !== null;
}

export async function getVisibleDealUnavailableReason(page: Page): Promise<string | null> {
  const missingMessages = page.getByText(/^Deal not found\s*[.!]?$/i);
  for (const message of await missingMessages.all()) {
    if (await message.isVisible()) return 'BFMR reports "Deal not found"';
  }
  const messages = page.getByText(/^(?:Deal Full(?:\s*[-–—]\s*Looks like you missed this one)?|No slots available|Deal closed|Sold out)\s*[.!]?$/i);
  for (const message of await messages.all()) {
    if (await message.isVisible()) return 'Deal is full or closed';
  }
  return null;
}
