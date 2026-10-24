import type { IAmazonProvider } from '../providers/interfaces';

export class SimulatedAmazonProvider implements IAmazonProvider {
  public async verifyAccount(_expectedAccount: string): Promise<'AUTHENTICATED' | 'AUTH_REQUIRED' | 'CHALLENGE'> {
    return 'AUTHENTICATED';
  }

  public async readSupplier(productUrl: string): Promise<{ asin: string; available: boolean; priceCents?: number }> {
    const asinMatch = productUrl.match(/\/dp\/([A-Z0-9]{10})/i) || productUrl.match(/\/gp\/product\/([A-Z0-9]{10})/i);
    const asin = asinMatch ? asinMatch[1].toUpperCase() : 'B0TESTASIN1';
    return {
      asin,
      available: true,
      priceCents: 7999,
    };
  }
}
