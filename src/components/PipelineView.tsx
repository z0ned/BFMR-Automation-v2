import React, { useState } from 'react';
import { 
  Play, 
  CheckCircle2, 
  AlertTriangle, 
  XCircle, 
  Layers, 
  Send, 
  Globe, 
  Database, 
  Terminal, 
  ExternalLink,
  Info
} from 'lucide-react';
import { orchestrator } from '../services/orchestrator';
import { PipelineStatus } from '../types/bfmr';

interface PipelineViewProps {
  status: PipelineStatus;
  onRefresh: () => void;
}

export const PipelineView: React.FC<PipelineViewProps> = ({ status, onRefresh }) => {
  const [subject, setSubject] = useState(
    'New Deal: Apple 11" iPad Pro M4 Chip 256GB Wi-Fi - Space Black'
  );
  const [sender, setSender] = useState('deals@buyformeretail.com');
  const [body, setBody] = useState(
    `A new deal has been posted on BFMR!\nLink: https://www.buyformeretail.com/deals/ipad-pro-m4-11-256\nPayout: $920.00\nRetail: $999.00\nRetailer: Best Buy\nQuantity Limit: 1`
  );
  const [isRunning, setIsRunning] = useState(false);
  const [resultMsg, setResultMsg] = useState<string | null>(null);

  // Preset scenarios conforming to Solution Design Specification v1.5
  const presets = [
    {
      label: 'Qualifying Single Deal (Amazon)',
      subject: 'New Deal: Sony WH-1000XM5 Wireless Headphones - Silver',
      body: 'Deal posted on BFMR!\nLink: https://www.buyformeretail.com/deals/sony-wh1000xm5-silver\nPayout: $330.00\nRetail: $399.99\nRetailer: Amazon',
      forceUncertain: false,
      simulatePageError: false,
      description: 'Single new deal with Amazon retailer, passes duplicate check, creates quantity 1 reservation.',
    },
    {
      label: 'Bundle Deal (Quantity 1 Offer)',
      subject: 'New Deal: Canon EOS R50 Mirrorless Camera + 18-45mm Lens Bundle',
      body: 'Special bundle deal!\nLink: https://www.buyformeretail.com/deals/canon-r50-lens-bundle\nPayout: $710.00\nRetail: $799.00\nRetailer: B&H Photo',
      forceUncertain: false,
      simulatePageError: false,
      description: 'Bundles are accepted per DECISIONS.md. Reserves 1 BFMR offer (not component units).',
    },
    {
      label: 'Duplicate Deal (My Tracker Active)',
      subject: 'New Deal: Nintendo Switch OLED Model Mario Red Edition',
      body: 'Deal available now!\nLink: https://www.buyformeretail.com/deals/switch-oled-mario-red\nPayout: $310.00\nRetail: $349.99\nRetailer: Amazon',
      forceUncertain: false,
      simulatePageError: false,
      description: 'Triggers AT-04. My Tracker already contains active RID-884890. Pipeline stops at T3 without clicking.',
    },
    {
      label: 'Disqualified: Multiple Deals Digest',
      subject: 'Multiple Deals: 5 deals available now on BFMR',
      body: 'Check out the multiple deals posted today at https://www.buyformeretail.com/deals/all',
      forceUncertain: false,
      simulatePageError: false,
      description: 'Disqualified at T2 per MVP 1 scope: multiple-deal emails are explicitly ignored.',
    },
    {
      label: 'Disqualified: Additional Slots Notice',
      subject: 'Additional slots opened for Apple Watch Series 9',
      body: 'More reservation slots available at https://www.buyformeretail.com/deals/apple-watch-s9',
      forceUncertain: false,
      simulatePageError: false,
      description: 'Disqualified at T2 per MVP 1 scope: additional slot notices are ignored.',
    },
    {
      label: 'Uncertain Outcome (Network Timeout)',
      subject: 'New Deal: Meta Quest 3 512GB VR Headset',
      body: 'High demand item!\nLink: https://www.buyformeretail.com/deals/meta-quest-3-512\nPayout: $590.00\nRetail: $649.99\nRetailer: Target',
      forceUncertain: true,
      simulatePageError: false,
      description: 'Simulates timeout after form submit. Triggers AT-14 stop gate: halts retry to prevent double booking.',
    },
    {
      label: 'Playwright Submit Failure (Max 2 Ordinals)',
      subject: 'New Deal: PlayStation 5 Pro Console',
      body: 'Console deal link: https://www.buyformeretail.com/deals/ps5-pro-console\nPayout: $680.00\nRetail: $699.99\nRetailer: Best Buy',
      forceUncertain: false,
      simulatePageError: true,
      description: 'Simulates HTTP 500 then retry failure. Triggers AT-09: attempts ordinal 1 & 2, then enters EXHAUSTED.',
    },
  ];

  const handleApplyPreset = (p: typeof presets[0]) => {
    setSubject(p.subject);
    setBody(p.body);
    setResultMsg(null);
  };

  const handleRunPipeline = async (forceUncertain = false, simulatePageError = false) => {
    setIsRunning(true);
    setResultMsg(null);
    try {
      const res = await orchestrator.processEmailPipeline({
        messageId: `<msg-${Date.now()}@buyformeretail.com>`,
        sender,
        subject,
        body,
        forceUncertain,
        simulatePageError,
      });
      setResultMsg(res.message);
      onRefresh();
    } finally {
      setIsRunning(false);
    }
  };

  const activeEmail = orchestrator.currentActiveEmail;
  const attempts = orchestrator.currentAttempts;

  // Stages
  const stages = [
    { id: 'T1', name: 'T1 Intake & Persist', desc: 'Gmail StreamingPull & durable record before ACK' },
    { id: 'T2', name: 'T2 Provenance & Dedupe', desc: 'Verify single new-deal & trusted BFMR domain' },
    { id: 'T3', name: 'T3 My Tracker Check', desc: 'Verify no existing active reservation or color variant' },
    { id: 'T4', name: 'T4 Durable Attempt', desc: 'Pre-allocate attempt record in database before click' },
    { id: 'T5', name: 'T5 Form Submission', desc: 'Playwright headed Chromium sets quantity 1 & submits' },
    { id: 'T6', name: 'T6 Reconcile Tracker', desc: 'Query My Tracker API to confirm RID and state' },
  ];

  const getStageState = (stageId: string) => {
    if (status === 'IDLE') return 'pending';
    if (stageId === 'T1') {
      return status === 'INGESTING' ? 'active' : 'completed';
    }
    if (stageId === 'T2') {
      if (status === 'INGESTING') return 'pending';
      if (status === 'SKIPPED_INVALID_FORMAT') return 'failed';
      return 'completed';
    }
    if (stageId === 'T3') {
      if (['INGESTING', 'SKIPPED_INVALID_FORMAT'].includes(status)) return 'pending';
      if (status === 'CHECKING_TRACKER') return 'active';
      if (status === 'SKIPPED_DUPLICATE') return 'failed';
      return 'completed';
    }
    if (stageId === 'T4') {
      if (['INGESTING', 'SKIPPED_INVALID_FORMAT', 'CHECKING_TRACKER', 'SKIPPED_DUPLICATE'].includes(status)) return 'pending';
      if (status === 'DURABLE_ATTEMPT') return 'active';
      return 'completed';
    }
    if (stageId === 'T5') {
      if (['INGESTING', 'SKIPPED_INVALID_FORMAT', 'CHECKING_TRACKER', 'SKIPPED_DUPLICATE', 'DURABLE_ATTEMPT'].includes(status)) return 'pending';
      if (status === 'SUBMITTING') return 'active';
      if (status === 'EXHAUSTED') return 'failed';
      return 'completed';
    }
    if (stageId === 'T6') {
      if (status === 'RECONCILING') return 'active';
      if (status === 'CONFIRMED') return 'completed';
      if (status === 'REVIEW_REQUIRED') return 'failed';
      return 'pending';
    }
    return 'pending';
  };

  return (
    <div className="space-y-6">
      {/* Top Banner & Info */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-white flex items-center gap-2">
              <Layers className="w-5 h-5 text-blue-500" />
              BFMR v2 Automation Pipeline
            </h2>
            <p className="text-sm text-slate-400 mt-1">
              Autonomous flow from qualifying deal email to Playwright quantity-1 submission and My Tracker verification.
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-300 bg-slate-950/80 px-3 py-2 rounded-lg border border-slate-800">
            <Info className="w-4 h-4 text-blue-400 shrink-0" />
            <span>Rule: At most 2 submit ordinals • No timed release • Reconcile uncertainty</span>
          </div>
        </div>
      </div>

      {/* Transaction Boundary Stepper (T1 - T6) */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-slate-300 uppercase tracking-wider mb-4 flex items-center gap-2">
          <span>Transaction Boundary State Machine (T1 – T6)</span>
        </h3>
        
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          {stages.map((st) => {
            const state = getStageState(st.id);
            return (
              <div
                key={st.id}
                className={`p-3 rounded-lg border transition-all ${
                  state === 'active'
                    ? 'bg-blue-950/40 border-blue-500 text-blue-200 ring-2 ring-blue-500/20'
                    : state === 'completed'
                    ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-200'
                    : state === 'failed'
                    ? 'bg-rose-950/30 border-rose-500/40 text-rose-200'
                    : 'bg-slate-950/60 border-slate-800 text-slate-400'
                }`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-mono text-xs font-bold px-1.5 py-0.5 rounded bg-slate-800 text-slate-200">
                    {st.id}
                  </span>
                  {state === 'completed' && <CheckCircle2 className="w-4 h-4 text-emerald-400" />}
                  {state === 'active' && <div className="w-2.5 h-2.5 rounded-full bg-blue-400 animate-ping" />}
                  {state === 'failed' && <XCircle className="w-4 h-4 text-rose-400" />}
                </div>
                <div className="text-xs font-semibold">{st.name}</div>
                <div className="text-[11px] text-slate-400 mt-1 leading-snug">{st.desc}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Interactive Simulation & Trigger Panel */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: Email Preset Selector & Raw Payload */}
        <div className="lg:col-span-7 space-y-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h3 className="text-base font-semibold text-white mb-3 flex items-center justify-between">
              <span>Simulate Incoming Gmail Trigger</span>
              <span className="text-xs font-normal text-slate-400">Google Pub/Sub StreamingPull</span>
            </h3>

            {/* Presets Grid */}
            <div className="mb-4">
              <label className="block text-xs font-medium text-slate-400 mb-2">Preset Scenarios (Specification v1.5):</label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {presets.map((p, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => handleApplyPreset(p)}
                    className="text-left p-2.5 rounded-lg bg-slate-800/80 hover:bg-slate-800 border border-slate-700/60 hover:border-blue-500/50 transition-all group"
                  >
                    <div className="text-xs font-semibold text-slate-200 group-hover:text-blue-400">{p.label}</div>
                    <div className="text-[11px] text-slate-400 line-clamp-1 mt-0.5">{p.description}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Form Fields */}
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Email Subject</label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm text-slate-200 focus:outline-none focus:border-blue-500 font-mono"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">From Header</label>
                  <input
                    type="text"
                    value={sender}
                    onChange={(e) => setSender(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-300 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Quantity Rule</label>
                  <div className="px-3 py-2 bg-slate-950/70 border border-slate-800 rounded-lg text-xs text-slate-300 font-mono flex items-center justify-between">
                    <span>Target Quantity: 1 offer</span>
                    <span className="text-[10px] text-blue-400 font-bold">LOCKED (MVP 1)</span>
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Raw Email Body (MIME content)</label>
                <textarea
                  rows={4}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-300 font-mono focus:outline-none focus:border-blue-500 leading-relaxed"
                />
              </div>

              {/* Action Buttons */}
              <div className="flex flex-wrap items-center gap-3 pt-2">
                <button
                  type="button"
                  disabled={isRunning}
                  onClick={() => handleRunPipeline(false, false)}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg text-sm font-semibold shadow-md shadow-blue-600/20 transition-all cursor-pointer"
                >
                  <Play className="w-4 h-4 fill-white" />
                  <span>Execute Pipeline</span>
                </button>

                <button
                  type="button"
                  disabled={isRunning}
                  onClick={() => handleRunPipeline(true, false)}
                  className="flex items-center gap-2 px-3 py-2 bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 border border-amber-600/40 rounded-lg text-xs font-medium transition-all cursor-pointer"
                >
                  <AlertTriangle className="w-3.5 h-3.5" />
                  <span>Simulate Uncertain (AT-14)</span>
                </button>

                <button
                  type="button"
                  disabled={isRunning}
                  onClick={() => handleRunPipeline(false, true)}
                  className="flex items-center gap-2 px-3 py-2 bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 border border-rose-600/40 rounded-lg text-xs font-medium transition-all cursor-pointer"
                >
                  <XCircle className="w-3.5 h-3.5" />
                  <span>Simulate 2 Failures (AT-09)</span>
                </button>
              </div>

              {/* Execution Result Notification */}
              {resultMsg && (
                <div className={`mt-3 p-3 rounded-lg border text-xs leading-relaxed ${
                  resultMsg.includes('Successfully')
                    ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300'
                    : resultMsg.includes('Duplicate')
                    ? 'bg-amber-950/40 border-amber-500/40 text-amber-300'
                    : resultMsg.includes('Ignored')
                    ? 'bg-slate-800 border-slate-700 text-slate-300'
                    : 'bg-rose-950/40 border-rose-500/40 text-rose-300'
                }`}>
                  <span className="font-semibold">Pipeline Result: </span>
                  {resultMsg}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right: Live Attempt Inspector & Headed Browser Simulation */}
        <div className="lg:col-span-5 space-y-4">
          {/* Active / Current Deal Inspection */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h3 className="text-sm font-semibold text-slate-200 uppercase tracking-wider mb-3 flex items-center justify-between">
              <span>Parsed Deal Attributes</span>
              {activeEmail?.canonicalDealId && (
                <span className="font-mono text-xs text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded border border-blue-500/20">
                  {activeEmail.canonicalDealId}
                </span>
              )}
            </h3>

            {activeEmail ? (
              <div className="space-y-2 text-xs">
                <div className="flex justify-between py-1 border-b border-slate-800">
                  <span className="text-slate-400">Deal Title</span>
                  <span className="text-slate-200 font-medium text-right max-w-[200px] truncate">{activeEmail.dealTitle}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-slate-800">
                  <span className="text-slate-400">Retailer</span>
                  <span className="text-slate-200 font-medium">{activeEmail.retailer}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-slate-800">
                  <span className="text-slate-400">Single Deal Status</span>
                  <span className={activeEmail.isSingleDeal ? 'text-emerald-400 font-semibold' : 'text-rose-400 font-semibold'}>
                    {activeEmail.isSingleDeal ? 'Qualifying Single Deal' : 'Disqualified'}
                  </span>
                </div>
                <div className="flex justify-between py-1 border-b border-slate-800">
                  <span className="text-slate-400">Bundle Offer</span>
                  <span className="text-slate-200">{activeEmail.isBundle ? 'Yes (Qty 1 offer)' : 'No (Standard item)'}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-slate-800">
                  <span className="text-slate-400">Trusted Destination URL</span>
                  <span className="text-blue-400 font-mono text-[11px] truncate max-w-[220px]">
                    {activeEmail.dealUrl || 'None'}
                  </span>
                </div>
              </div>
            ) : (
              <p className="text-xs text-slate-500 italic py-4 text-center">
                No active email currently undergoing execution.
              </p>
            )}
          </div>

          {/* Playwright Headed Chromium Execution Simulation */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h3 className="text-sm font-semibold text-slate-200 uppercase tracking-wider mb-3 flex items-center justify-between">
              <span>Playwright Attempt Monitor</span>
              <span className="text-xs text-slate-400 font-mono">Max 2 Ordinals</span>
            </h3>

            {attempts.length > 0 ? (
              <div className="space-y-2.5">
                {attempts.map((att) => (
                  <div
                    key={att.id}
                    className="p-3 bg-slate-950 border border-slate-800 rounded-lg text-xs space-y-1.5"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono font-bold text-blue-400 bg-blue-500/10 px-1.5 py-0.5 rounded border border-blue-500/20">
                          Ordinal #{att.ordinal}
                        </span>
                        <span className="text-slate-300 font-mono">{att.stage}</span>
                      </div>
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        att.status === 'SUCCESS'
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                          : att.status === 'UNCERTAIN'
                          ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                          : att.status === 'FAILED'
                          ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                          : 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                      }`}>
                        {att.status}
                      </span>
                    </div>

                    <div className="text-[11px] text-slate-400 font-mono">
                      Timestamp: {new Date(att.timestamp).toLocaleTimeString()}
                    </div>

                    {att.errorMessage && (
                      <div className="text-[11px] text-rose-400 bg-rose-950/30 p-1.5 rounded border border-rose-800/40">
                        {att.errorMessage}
                      </div>
                    )}

                    {att.reconciledWithTracker && (
                      <div className="text-[11px] text-emerald-400 flex items-center gap-1">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>Confirmed in My Tracker API read</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-slate-500 italic py-6 text-center">
                Waiting for form submission trigger.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
