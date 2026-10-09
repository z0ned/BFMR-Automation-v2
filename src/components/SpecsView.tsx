import React, { useState } from 'react';
import { FileText, CheckCircle2, AlertTriangle, ShieldCheck, HelpCircle } from 'lucide-react';

export const SpecsView: React.FC = () => {
  const [activeDoc, setActiveDoc] = useState<'DECISIONS' | 'PLAN' | 'ISSUES' | 'DESIGN'>('DECISIONS');

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <FileText className="w-5 h-5 text-indigo-400" />
            Specification & Decision Register
          </h2>
          <p className="text-sm text-slate-400 mt-1">
            Authoritative scope baseline from Solution Design Specification v1.5 and 9 October 2026 decisions.
          </p>
        </div>
      </div>

      {/* Sub-nav buttons */}
      <div className="flex space-x-2 border-b border-slate-800 pb-2">
        <button
          onClick={() => setActiveDoc('DECISIONS')}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
            activeDoc === 'DECISIONS'
              ? 'bg-blue-600 text-white'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
          }`}
        >
          Decision Register (DECISIONS.md)
        </button>
        <button
          onClick={() => setActiveDoc('PLAN')}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
            activeDoc === 'PLAN'
              ? 'bg-blue-600 text-white'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
          }`}
        >
          Implementation Plan (IMPLEMENTATION_PLAN.md)
        </button>
        <button
          onClick={() => setActiveDoc('ISSUES')}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
            activeDoc === 'ISSUES'
              ? 'bg-blue-600 text-white'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
          }`}
        >
          Open Issues & Inputs (OPEN_ISSUES.md)
        </button>
        <button
          onClick={() => setActiveDoc('DESIGN')}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
            activeDoc === 'DESIGN'
              ? 'bg-blue-600 text-white'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
          }`}
        >
          Design Spec v1.5 Key Points
        </button>
      </div>

      {/* Content Panels */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
        {activeDoc === 'DECISIONS' && (
          <div className="space-y-4">
            <h3 className="text-base font-bold text-white">Final User Decisions (9 October 2026)</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-950 font-mono text-slate-400 border-b border-slate-800">
                  <tr>
                    <th className="py-2.5 px-3">Topic</th>
                    <th className="py-2.5 px-3">Authoritative Final Decision</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800 text-slate-300">
                  <tr>
                    <td className="py-2.5 px-3 font-semibold text-white">Starting point</td>
                    <td className="py-2.5 px-3">Fresh implementation in this repository; no reuse of earlier codebase</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 px-3 font-semibold text-white">Platform</td>
                    <td className="py-2.5 px-3">Ubuntu with Playwright bundled Chromium in headed mode</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 px-3 font-semibold text-white">Trigger</td>
                    <td className="py-2.5 px-3">Single new-deal email; no required retailer channel in subject</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 px-3 font-semibold text-white">Retailers</td>
                    <td className="py-2.5 px-3">All retailers; Amazon-only restriction withdrawn</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 px-3 font-semibold text-white">Bundles</td>
                    <td className="py-2.5 px-3">Included; quantity 1 refers to the BFMR offer</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 px-3 font-semibold text-white">Additional slots / multiple deals</td>
                    <td className="py-2.5 px-3">Excluded from MVP 1 (ignored by intake)</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 px-3 font-semibold text-white">Business eligibility</td>
                    <td className="py-2.5 px-3">No financial, stock, profitability, or retailer-eligibility evaluation</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 px-3 font-semibold text-white">Duplicate protection</td>
                    <td className="py-2.5 px-3">Check My Tracker before reserving; any active reservation for the same deal blocks creation</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 px-3 font-semibold text-white">Navigation</td>
                    <td className="py-2.5 px-3">Open trusted email deal link directly in authenticated browser; no mandatory Active Deals API resolution</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 px-3 font-semibold text-white">Reservation creation</td>
                    <td className="py-2.5 px-3">Playwright website form only; no reservation-creation API</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 px-3 font-semibold text-white">Confirmation</td>
                    <td className="py-2.5 px-3">My Tracker API</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 px-3 font-semibold text-white">Testing</td>
                    <td className="py-2.5 px-3">Real reservations in testing and production modes</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 px-3 font-semibold text-white">Release</td>
                    <td className="py-2.5 px-3">Entirely manual; no one-minute or failed-eligibility release</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 px-3 font-semibold text-white">Purchasing</td>
                    <td className="py-2.5 px-3">Outside MVP 1</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 px-3 font-semibold text-white">Downtime</td>
                    <td className="py-2.5 px-3">Catch up and process qualifying missed emails using durable cursor and dedupe</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeDoc === 'PLAN' && (
          <div className="space-y-4">
            <h3 className="text-base font-bold text-white">Milestone Architecture (M0 – M5)</h3>
            <div className="space-y-3 text-xs text-slate-300">
              <div className="p-3 bg-slate-950 rounded-lg border border-slate-800">
                <span className="font-bold text-indigo-400">M0 Establish Fresh Project: </span>
                Clean-checkout setup, non-secret examples, pinned dependencies, zero legacy code.
              </div>
              <div className="p-3 bg-slate-950 rounded-lg border border-slate-800">
                <span className="font-bold text-indigo-400">M1 Durable Orchestration & Ownership: </span>
                Enforce single browser/account owner, transactions T1-T6, durable retry budgets, offline failure mocks.
              </div>
              <div className="p-3 bg-slate-950 rounded-lg border border-slate-800">
                <span className="font-bold text-indigo-400">M2 Gmail and Pub/Sub Intake: </span>
                Watch renewal, StreamingPull, persistence before ACK, serialized history reads, single-deal filter.
              </div>
              <div className="p-3 bg-slate-950 rounded-lg border border-slate-800">
                <span className="font-bold text-indigo-400">M3 Validate BFMR Read Contracts: </span>
                Dedicated authenticated browser navigation, stable deal extraction, My Tracker duplicate checks, bundle quantity-1.
              </div>
              <div className="p-3 bg-slate-950 rounded-lg border border-slate-800">
                <span className="font-bold text-indigo-400">M4 Reservation & Operational Controls: </span>
                One-unit website-form submission, reconciliation, max 2 submit ordinals, Telegram incidents, local CLI.
              </div>
              <div className="p-3 bg-slate-950 rounded-lg border border-slate-800">
                <span className="font-bold text-indigo-400">M5 Ubuntu Deployment & Acceptance: </span>
                Service packaging, headed Chromium desktop access, encrypted backups, runbooks.
              </div>
            </div>
          </div>
        )}

        {activeDoc === 'ISSUES' && (
          <div className="space-y-4">
            <h3 className="text-base font-bold text-white">Open Issues & Boundaries (OPEN_ISSUES.md)</h3>
            <div className="space-y-3 text-xs text-slate-300">
              <div className="p-3 bg-slate-950 rounded-lg border border-slate-800">
                <div className="font-bold text-amber-400 mb-1">OQ-001 Recovery after Gmail history expires</div>
                <p className="leading-relaxed">
                  If Gmail rejects an expired historyId cursor, the specified behavior is to preserve the gap, alert, and stop new intake.
                  Restart CANNOT silently reset it or execute an unauthorized inbox sweep.
                </p>
              </div>

              <div className="p-3 bg-slate-950 rounded-lg border border-slate-800">
                <div className="font-bold text-blue-400 mb-1">EV-001 BFMR browser identity and quantity</div>
                <p className="leading-relaxed">
                  Prove direct email-link navigation, expected account identity, canonical deal_id extraction, correct form/offer association,
                  bundle quantity-one meaning, and variant selection. Unknown identity cannot submit.
                </p>
              </div>

              <div className="p-3 bg-slate-950 rounded-lg border border-slate-800">
                <div className="font-bold text-blue-400 mb-1">EV-002 My Tracker contract</div>
                <p className="leading-relaxed">
                  Verify complete read guarantee: missing pages, failed reads, and unknown shapes never prove absence.
                  Immediate visibility required before reconciling uncertain outcomes.
                </p>
              </div>

              <div className="p-3 bg-slate-950 rounded-lg border border-slate-800">
                <div className="font-bold text-blue-400 mb-1">SETUP-001 Secure service configuration</div>
                <p className="leading-relaxed">
                  All secrets, OAuth material, browser profiles, and API tokens must be supplied via local configuration; never in Git.
                </p>
              </div>
            </div>
          </div>
        )}

        {activeDoc === 'DESIGN' && (
          <div className="space-y-4 text-xs text-slate-300 leading-relaxed">
            <h3 className="text-base font-bold text-white">BFMR Solution Design Specification v1.5 Highlights</h3>
            <p>
              The system runs on a dedicated Ubuntu host with local PostgreSQL and headed Chromium controlled by Playwright.
              The workflow is initiated by a qualifying single new-deal notification from BFMR.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
              <div className="p-3 bg-slate-950 border border-slate-800 rounded-lg">
                <div className="font-bold text-white mb-1">Single Browser Owner</div>
                <p>Only one worker process controls the browser session at any time to prevent concurrency collisions on BFMR's session.</p>
              </div>
              <div className="p-3 bg-slate-950 border border-slate-800 rounded-lg">
                <div className="font-bold text-white mb-1">Durable Attempt Record</div>
                <p>Stage T4 allocates a database attempt row before any click is dispatched in Stage T5. Ensures 100% auditability.</p>
              </div>
              <div className="p-3 bg-slate-950 border border-slate-800 rounded-lg">
                <div className="font-bold text-white mb-1">Max 2 Submit Ordinals</div>
                <p>If attempt 1 fails with an explicit failure, exactly 1 retry is permitted (ordinal 2). Further attempts enter EXHAUSTED.</p>
              </div>
              <div className="p-3 bg-slate-950 border border-slate-800 rounded-lg">
                <div className="font-bold text-white mb-1">Uncertainty Stop Gate</div>
                <p>Network timeout or unconfirmed submission never auto-retries. Pipeline immediately stops to protect against double orders.</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
