import type { IClock } from '../interfaces';

/**
 * Default wall-clock implementation using system time.
 */
export class SystemClock implements IClock {
  public now(): Date {
    return new Date();
  }

  public async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  public isPast(date: Date): boolean {
    return Date.now() > date.getTime();
  }
}
