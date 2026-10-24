import type { IClock } from '../providers/interfaces';

export class SimulatedClock implements IClock {
  private currentTime: Date;

  constructor(initialTime?: Date) {
    this.currentTime = initialTime ? new Date(initialTime.getTime()) : new Date();
  }

  public now(): Date {
    return new Date(this.currentTime.getTime());
  }

  public advance(seconds: number): Date {
    this.currentTime = new Date(this.currentTime.getTime() + seconds * 1000);
    return this.now();
  }

  public async sleep(_ms: number): Promise<void> {
    // In simulation mode, workflow sleeps are instantaneous or controlled
    return Promise.resolve();
  }

  public isPast(date: Date): boolean {
    return this.currentTime.getTime() > date.getTime();
  }
}
