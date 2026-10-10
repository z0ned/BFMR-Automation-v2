import { errors, type Page } from 'playwright';

/** Describe a failed read without logging page HTML, account text or candidate titles. */
export async function describeDealTitleFailure(page: Page): Promise<string> {
  const details = await page.evaluate(() => {
    const tags: string[] = [];
    for (const heading of document.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6, [role="heading"]')) {
      const style = window.getComputedStyle(heading);
      if (!heading.getClientRects().length || style.visibility === 'hidden' || style.visibility === 'collapse' ||
        heading.closest('nav, aside, header, footer, [role="navigation"]')) continue;
      const title = heading.innerText.replace(/\s+/g, ' ').trim();
      if (!title || /^(?:deal details|to deals|deals|my tracker|payout price|retail price|full retail)\s*:?$/i.test(title)) continue;
      tags.push(heading.tagName.toLowerCase());
    }
    const text = document.body?.innerText || '';
    return {
      count: tags.length,
      tags: [...new Set(tags)],
      payout: /payout price\s*:/i.test(text),
      retail: /retail price\s*:/i.test(text),
    };
  });
  return `visible candidate headings=${details.count} (${details.tags.join(', ') || 'none'}); Payout Price label=${details.payout}; Retail Price label=${details.retail}`;
}

/** Read one rendered product heading associated with the deal's pricing section. */
export async function readVisibleDealTitle(page: Page, timeoutMs = 10000): Promise<string | null> {
  try {
    const result = await page.waitForFunction(() => {
      const candidates: { title: string; section: HTMLElement; level: number }[] = [];
      const headings = document.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6, [role="heading"]');
      for (const heading of headings) {
        const style = window.getComputedStyle(heading);
        if (!heading.getClientRects().length || style.visibility === 'hidden' || style.visibility === 'collapse' ||
          heading.closest('nav, aside, header, footer, [role="navigation"]')) continue;
        const title = heading.innerText.replace(/\s+/g, ' ').trim();
        if (!title || /^(?:deal details|to deals|deals|my tracker|payout price|retail price|full retail)\s*:?$/i.test(title)) continue;

        // The screenshot shows the catalog title beside Payout Price / Retail Price.
        // Do not use arbitrary page headings, email subjects or URL-derived titles.
        for (let section = heading.parentElement; section; section = section.parentElement) {
          const text = section.innerText;
          if (/payout price\s*:/i.test(text) && /retail price\s*:/i.test(text)) {
            const explicitLevel = Number(heading.getAttribute('aria-level'));
            const tagLevel = /^H[1-6]$/.test(heading.tagName) ? Number(heading.tagName[1]) : 6;
            const level = explicitLevel >= 1 && explicitLevel <= 6 ? explicitLevel : tagLevel;
            candidates.push({ title, section, level });
            break;
          }
        }
      }
      // A heading elsewhere on the page must not inherit pricing context
      // merely because its ancestor is main/body. Prefer the tightest section
      // containing both prices, then its principal semantic heading.
      const scoped = candidates.filter(candidate => !candidates.some(other =>
        other.section !== candidate.section && candidate.section.contains(other.section)));
      if (!scoped.length || new Set(scoped.map(candidate => candidate.section)).size !== 1) return false;
      const level = Math.min(...scoped.map(candidate => candidate.level));
      const titles = new Set(scoped.filter(candidate => candidate.level === level).map(candidate => candidate.title));
      return titles.size === 1 ? [...titles][0] : false;
    }, undefined, { timeout: timeoutMs, polling: 100 });
    try {
      return await result.jsonValue() as string;
    } finally {
      await result.dispose();
    }
  } catch (error) {
    if (error instanceof errors.TimeoutError) return null;
    throw error;
  }
}
