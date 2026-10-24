import type { ScenarioDefinition } from './types';

export const SCENARIO_CATALOG: ScenarioDefinition[] = [
  {
    id: 'phase1-single-deal-success',
    name: 'Single New Deal — Clean Reservation',
    phase: 1,
    description:
      'Standard happy path. An email arrives announcing a single eligible deal. The simulated browser verifies the deal page, selects quantity 1, commits the reservation, and My Tracker confirms it.',
    expectedOutcome:
      'Exactly one reservation is created in provider truth, verified in My Tracker, and recorded in application SQL (deal_reservations). State diff is 100% matched.',
    initialDeals: [
      {
        dealId: '10001',
        slug: 'apple-ipad-10th-gen-64gb',
        title: 'Apple iPad 10th Gen 64GB Wi-Fi (Silver)',
        dealUrl: 'https://bfmr.com/deals/apple-ipad-10th-gen-64gb',
        retailer: 'Amazon',
        isClosed: false,
        availableSlots: 5,
        payoutCents: 32000,
        retailCents: 29900,
        asin: 'B0BJLEVMJQ',
      },
    ],
    sampleEmail: {
      sender: 'deals@buyformeretail.com',
      subject: 'NEW DEAL | Apple iPad 10th Gen 64GB Wi-Fi (Silver) | Amazon',
      body: `<h2>NEW DEAL</h2>
<p>We posted a new deal!</p>
<p>• Apple iPad 10th Gen 64GB Wi-Fi (Silver)</p>
<p>Retailer: Amazon</p>
<p>Payout: $320.00 | Retail: $299.00</p>
<a href="https://bfmr.com/deals/apple-ipad-10th-gen-64gb">Apple iPad 10th Gen 64GB Wi-Fi (Silver)</a>`,
    },
  },
  {
    id: 'phase1-multi-deal-announcement',
    name: 'Multi-Deal Announcement — Quantity One Barrier',
    phase: 1,
    description:
      'Email announces two distinct deals in one body. Workflow executes the reservation barrier: reserving quantity 1 for each deal sequentially before moving to evaluation.',
    expectedOutcome:
      'Both deals are reserved (1 unit each) in provider truth and application SQL before any subsequent evaluation. Neither deal is duplicated.',
    initialDeals: [
      {
        dealId: '10002',
        slug: 'bose-qc45-headphones-black',
        title: 'Bose QuietComfort 45 Bluetooth Wireless Headphones (Triple Black)',
        dealUrl: 'https://bfmr.com/deals/bose-qc45-headphones-black',
        retailer: 'Amazon',
        isClosed: false,
        availableSlots: 3,
        payoutCents: 22000,
        retailCents: 19900,
        asin: 'B098FKXT8L',
      },
      {
        dealId: '10003',
        slug: 'sony-wh1000xm5-silver',
        title: 'Sony WH-1000XM5 Wireless Noise Canceling Headphones (Silver)',
        dealUrl: 'https://bfmr.com/deals/sony-wh1000xm5-silver',
        retailer: 'Amazon',
        isClosed: false,
        availableSlots: 4,
        payoutCents: 34000,
        retailCents: 32900,
        asin: 'B09XSDJ8ND',
      },
    ],
    sampleEmail: {
      sender: 'deals@buyformeretail.com',
      subject: 'TWO NEW DEALS | Bose QC45 & Sony WH-1000XM5',
      body: `<h2>NEW DEALS</h2>
<p>We posted two new deals!</p>
<p>• Bose QuietComfort 45 Bluetooth Wireless Headphones (Triple Black)</p>
<a href="https://bfmr.com/deals/bose-qc45-headphones-black">Bose QuietComfort 45</a>
<br/><br/>
<p>• Sony WH-1000XM5 Wireless Noise Canceling Headphones (Silver)</p>
<a href="https://bfmr.com/deals/sony-wh1000xm5-silver">Sony WH-1000XM5</a>`,
    },
  },
  {
    id: 'phase1-confirmation-lost',
    name: 'Committed Reservation — Confirmation Lost (Discrepancy)',
    phase: 1,
    description:
      'Simulates the critical distributed fault: reservation commits successfully in BFMR provider truth, but the browser network connection drops before receiving acknowledgment.',
    expectedOutcome:
      'The simulated provider retains 1 reserved record. The application halts with UNCERTAIN status and pauses for reconciliation. A rerun or retry will not duplicate the reservation.',
    initialDeals: [
      {
        dealId: '10004',
        slug: 'apple-watch-series-10-42mm',
        title: 'Apple Watch Series 10 [GPS 42mm] Smartwatch with Jet Black Case',
        dealUrl: 'https://bfmr.com/deals/apple-watch-series-10-42mm',
        retailer: 'Amazon',
        isClosed: false,
        availableSlots: 2,
        payoutCents: 38000,
        retailCents: 37900,
        asin: 'B0DGJ9Y1Q5',
      },
    ],
    faults: [
      {
        id: 'fault-lost-confirmation',
        targetOp: 'SUBMIT_RESERVATION',
        faultType: 'DROP_CONFIRMATION_AFTER_COMMIT',
        triggerOnAttempt: 1,
        errorDetail: 'Simulated connection drop: BFMR committed reservation but acknowledgment timed out',
      },
    ],
    sampleEmail: {
      sender: 'deals@buyformeretail.com',
      subject: 'NEW DEAL | Apple Watch Series 10 [GPS 42mm] Jet Black',
      body: `<h2>NEW DEAL</h2>
<p>• Apple Watch Series 10 [GPS 42mm] Smartwatch with Jet Black Case</p>
<p>Payout: $380.00 | Retail: $379.00</p>
<a href="https://bfmr.com/deals/apple-watch-series-10-42mm">Apple Watch Series 10 [GPS 42mm]</a>`,
    },
  },
  {
    id: 'phase1-deal-closed-no-slots',
    name: 'Deal Closed — Zero Slots Available',
    phase: 1,
    description:
      'Deal reservation slots are exhausted before submission. The simulated browser observes that quantity controls or the Reserve button are closed.',
    expectedOutcome:
      'Workflow skips the deal cleanly with CLOSED_NO_SLOTS. Zero reservations created in provider or application database.',
    initialDeals: [
      {
        dealId: '10005',
        slug: 'playstation-5-pro-console',
        title: 'PlayStation 5 Pro Console (Limited Edition)',
        dealUrl: 'https://bfmr.com/deals/playstation-5-pro-console',
        retailer: 'Amazon',
        isClosed: true,
        availableSlots: 0,
        payoutCents: 75000,
        retailCents: 69999,
        asin: 'B0DH9H2YBW',
      },
    ],
    sampleEmail: {
      sender: 'deals@buyformeretail.com',
      subject: 'NEW DEAL | PlayStation 5 Pro Console',
      body: `<h2>NEW DEAL</h2>
<p>• PlayStation 5 Pro Console</p>
<a href="https://bfmr.com/deals/playstation-5-pro-console">PlayStation 5 Pro Console</a>`,
    },
  },
  {
    id: 'phase1-incomplete-tracker-read',
    name: 'My Tracker Failure — Defensive Stop',
    phase: 1,
    description:
      'Simulates a network timeout or HTTP 500 while reading My Tracker before reservation. In accordance with EV-003, incomplete tracker reads must never be treated as absence of reservations.',
    expectedOutcome:
      'The preflight check fails defensively with UNKNOWN. Workflow stops immediately without attempting any browser submission.',
    initialDeals: [
      {
        dealId: '10006',
        slug: 'macbook-air-13-inch-m3',
        title: 'Apple 2024 MacBook Air 13-inch Laptop with M3 chip',
        dealUrl: 'https://bfmr.com/deals/macbook-air-13-inch-m3',
        retailer: 'Amazon',
        isClosed: false,
        availableSlots: 3,
        payoutCents: 98000,
        retailCents: 94900,
        asin: 'B0CX234P7L',
      },
    ],
    faults: [
      {
        id: 'fault-tracker-failure',
        targetOp: 'TRACKER_READ',
        faultType: 'INCOMPLETE_READ',
        triggerOnAttempt: 1,
        errorDetail: 'Simulated 500 error from api.bfmr.com/api/v2/mytracker',
      },
    ],
    sampleEmail: {
      sender: 'deals@buyformeretail.com',
      subject: 'NEW DEAL | Apple 2024 MacBook Air 13-inch M3',
      body: `<h2>NEW DEAL</h2>
<p>• Apple 2024 MacBook Air 13-inch Laptop with M3 chip</p>
<a href="https://bfmr.com/deals/macbook-air-13-inch-m3">Apple 2024 MacBook Air 13-inch M3</a>`,
    },
  },
  {
    id: 'phase2-budget-headphones-purchase',
    name: 'Phase 2 — Eligible Amazon Purchase',
    phase: 2,
    purchaseStart: 'END_TO_END',
    description: 'End-to-end path through a quantity-one reservation, fixed checkout policy checks, and one confirmed simulated Amazon order.',
    expectedOutcome: 'One reserved offer produces one synthetic order with exact ASIN, quantity, and complete total. No BFMR Purchase/Shipment update is attempted.',
    initialDeals: [{
      dealId: '20001', slug: 'synthetic-budget-headphones', title: 'Synthetic Budget Headphones',
      dealUrl: 'https://bfmr.com/deals/synthetic-budget-headphones', retailer: 'Amazon',
      isClosed: false, availableSlots: 3, payoutCents: 9000, retailCents: 7500, asin: 'B0SIMPHASE',
    }],
    amazon: {
      accountEmail: 'buyer@example.invalid', accountState: 'AUTHENTICATED', asin: 'B0SIMPHASE', available: true,
      quantity: 1, itemSubtotalCents: 7500, shippingCents: 0, taxCents: 500, discountCents: 0,
      isGift: true, isFreeNonPrimeDelivery: true, addressMatches: true, paymentCardMatches: true,
      cartState: 'EMPTY', deliveryEstimate: { type: 'ABSENT', rawText: 'No delivery estimate shown' },
      existingUnpaidPayoutCents: 0, orderVisibilityDelaySeconds: 0,
    },
    sampleEmail: {
      sender: 'deals@buyformeretail.com', subject: 'NEW DEAL | Synthetic Budget Headphones | Amazon',
      body: `<h2>NEW DEAL</h2><p>• Synthetic Budget Headphones</p><p>Retailer: Amazon</p><p>Payout: $90.00 | Retail: $75.00</p><a href="https://bfmr.com/deals/synthetic-budget-headphones">Synthetic Budget Headphones</a>`,
    },
  },
  {
    id: 'phase3-amazon-tracking',
    name: 'Phase 3 — Amazon Shipment Tracking',
    phase: 3,
    trackingStart: 'SEEDED_ORDER',
    description: 'Tracks either an order produced by the Phase 2 purchase workflow or a seeded confirmed order through simulated Amazon and BFMR states.',
    expectedOutcome: 'Exact Amazon order and shipment evidence updates the application ledger; the matching synthetic BFMR Purchase and Shipment are confirmed by tracker readback. Amazon delivery updates do not change BFMR delivery status.',
    initialDeals: [{
      dealId: '30001', slug: 'synthetic-tracking-headphones', title: 'Synthetic Tracking Headphones',
      dealUrl: 'https://bfmr.com/deals/synthetic-tracking-headphones', retailer: 'Amazon',
      isClosed: false, availableSlots: 2, payoutCents: 9000, retailCents: 7500, asin: 'B0SIMPHASE',
    }],
    amazon: {
      accountEmail: 'buyer@example.invalid', accountState: 'AUTHENTICATED', asin: 'B0SIMPHASE', available: true,
      quantity: 1, itemSubtotalCents: 7500, shippingCents: 0, taxCents: 500, discountCents: 0,
      isGift: true, isFreeNonPrimeDelivery: true, addressMatches: true, paymentCardMatches: true,
      cartState: 'EMPTY', deliveryEstimate: { type: 'ABSENT', rawText: 'No delivery estimate shown' },
      existingUnpaidPayoutCents: 0, orderVisibilityDelaySeconds: 0,
    },
    tracking: {
      initialStatus: 'SHIPPED', trackingNumber: 'TBA1234567890', carrier: 'Amazon Logistics',
      visibilityDelaySeconds: 0, purchaseAgeHours: 24, orderIdMatches: true, asinMatches: true, totalMatches: true,
    },
    sampleEmail: {
      sender: 'deals@buyformeretail.com', subject: 'NEW DEAL | Synthetic Tracking Headphones | Amazon',
      body: `<h2>NEW DEAL</h2><p>• Synthetic Tracking Headphones</p><p>Retailer: Amazon</p><p>Payout: $90.00 | Retail: $75.00</p><a href="https://bfmr.com/deals/synthetic-tracking-headphones">Synthetic Tracking Headphones</a>`,
    },
  },
];
