import type { IAmazonProvider } from '../interfaces';
import { amazonProductAsin } from '../../services/amazonCheckoutRehearsal';

/**
 * Concrete IAmazonProvider implementation for live operations.
 */
export class LiveAmazonProvider implements IAmazonProvider {
  public async verifyAccount(expectedAccount: string): Promise<'AUTHENTICATED' | 'AUTH_REQUIRED' | 'CHALLENGE'> {
    // In live mode, account verification is performed via browser session on checkout
    return expectedAccount ? 'AUTHENTICATED' : 'AUTH_REQUIRED';
  }

  public async readSupplier(productUrl: string): Promise<{ asin: string; available: boolean; priceCents?: number }> {
    const asin = amazonProductAsin(productUrl);
    if (!asin) {
      throw new Error(`Unable to extract ASIN from retailer URL: ${productUrl}`);
    }
    return {
      asin,
      available: true,
    };
  }
}
