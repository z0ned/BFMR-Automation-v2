import { ReservationRecord } from '../types/bfmr';

// Initial pre-existing reservations in My Tracker (simulated production / seed data)
const initialReservations: ReservationRecord[] = [
  {
    rid: 'RID-884912',
    canonicalDealId: 'ipad-pro-m4-11-256',
    title: 'Apple 11" iPad Pro M4 Chip 256GB Wi-Fi - Space Black',
    retailer: 'Best Buy',
    quantity: 1,
    status: 'ACTIVE',
    reservedAt: new Date(Date.now() - 3600 * 1000 * 4).toISOString(),
    createdAtSource: 'MANUAL_WEB',
    colorVariant: 'Space Black',
    notes: 'Matt reserved manually from phone',
  },
  {
    rid: 'RID-884890',
    canonicalDealId: 'switch-oled-mario-red',
    title: 'Nintendo Switch OLED Model Mario Red Edition',
    retailer: 'Amazon',
    quantity: 1,
    status: 'ACTIVE',
    reservedAt: new Date(Date.now() - 3600 * 1000 * 18).toISOString(),
    createdAtSource: 'AUTOMATION_MVP1',
    colorVariant: 'Red',
    notes: 'Automated test reservation',
  },
  {
    rid: 'RID-884705',
    canonicalDealId: 'airpods-pro-2-usb-c',
    title: 'Apple AirPods Pro 2nd Gen with USB-C MagSafe Case',
    retailer: 'Target',
    quantity: 1,
    status: 'RELEASED_MANUALLY',
    reservedAt: new Date(Date.now() - 3600 * 1000 * 48).toISOString(),
    createdAtSource: 'AUTOMATION_MVP1',
    colorVariant: 'White',
    notes: 'Released manually by Matt after order shipped',
  },
];

class MyTrackerService {
  private records: ReservationRecord[] = [...initialReservations];
  private simulateNetworkLatency = 120; // ms

  public getActiveReservations(): ReservationRecord[] {
    return this.records.filter((r) => r.status === 'ACTIVE');
  }

  public getAllReservations(): ReservationRecord[] {
    return [...this.records];
  }

  /**
   * Check if an active reservation exists for the canonical deal.
   * Per v1.5 Spec & DECISIONS.md:
   * "Check My Tracker before reserving; any active reservation for the same deal blocks creation,
   * including a manual reservation or another color variant."
   */
  public async checkExistingReservation(canonicalDealId: string): Promise<{
    hasDuplicate: boolean;
    existingRecord?: ReservationRecord;
    reason?: string;
  }> {
    await new Promise((resolve) => setTimeout(resolve, this.simulateNetworkLatency));

    // Normalize canonical deal ID for comparison
    const normId = canonicalDealId.toLowerCase().trim();
    const active = this.records.find(
      (r) => r.status === 'ACTIVE' && r.canonicalDealId.toLowerCase().trim() === normId
    );

    if (active) {
      return {
        hasDuplicate: true,
        existingRecord: active,
        reason: `Active reservation ${active.rid} already exists for deal '${canonicalDealId}' (Source: ${active.createdAtSource}, Reserved at: ${active.reservedAt})`,
      };
    }

    return {
      hasDuplicate: false,
    };
  }

  /**
   * Add a confirmed reservation record (Quantity 1 per MVP 1 rule)
   */
  public async recordReservation(data: {
    canonicalDealId: string;
    title: string;
    retailer: string;
    colorVariant?: string;
    source?: 'AUTOMATION_MVP1' | 'MANUAL_WEB';
  }): Promise<ReservationRecord> {
    const rid = `RID-${Math.floor(100000 + Math.random() * 900000)}`;
    const newRecord: ReservationRecord = {
      rid,
      canonicalDealId: data.canonicalDealId,
      title: data.title,
      retailer: data.retailer,
      quantity: 1, // Quantity 1 offer per MVP 1
      status: 'ACTIVE',
      reservedAt: new Date().toISOString(),
      createdAtSource: data.source || 'AUTOMATION_MVP1',
      colorVariant: data.colorVariant || 'Default',
      notes: 'Reserved via Playwright form automation',
    };

    this.records.unshift(newRecord);
    return newRecord;
  }

  /**
   * Manual release by Matt.
   * Per Decision Register: "Matt releases reservations manually; no automatic timed release."
   */
  public manualReleaseReservation(rid: string): boolean {
    const record = this.records.find((r) => r.rid === rid);
    if (record) {
      record.status = 'RELEASED_MANUALLY';
      record.notes = `Released manually by Matt at ${new Date().toLocaleTimeString()}`;
      return true;
    }
    return false;
  }

  public resetToDefault(): void {
    this.records = [...initialReservations];
  }
}

export const myTrackerService = new MyTrackerService();
