import { useEffect, useState } from 'react';
import {
  Play,
  RotateCcw,
  CheckCircle2,
  AlertCircle,
  Clock,
  Database,
  ArrowRight,
  ShieldAlert,
  FastForward,
  Terminal,
  Activity,
} from 'lucide-react';
import type {
  PurchaseScenarioStart,
  ScenarioDefinition,
  SimulatedAmazonScenario,
  ScriptedFault,
  SimulationRunRecord,
  StateComparisonDiff,
} from './simulation/types';

export default function App() {
  const [scenarios, setScenarios] = useState<ScenarioDefinition[]>([]);
  const [selectedScenarioId, setSelectedScenarioId] = useState<string>('');
  const [activeRun, setActiveRun] = useState<SimulationRunRecord | null>(null);
  const [diff, setDiff] = useState<StateComparisonDiff | null>(null);
  const [activeTab, setActiveTab] = useState<'diff' | 'provider' | 'app' | 'logs'>('diff');
  const [isLoading, setIsLoading] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [notificationMsg, setNotificationMsg] = useState<string | null>(null);
  const [amazonDraft, setAmazonDraft] = useState<SimulatedAmazonScenario | null>(null);
  const [purchaseStart, setPurchaseStart] = useState<PurchaseScenarioStart>('END_TO_END');
  const [faultDrafts, setFaultDrafts] = useState<ScriptedFault[]>([]);

  useEffect(() => {
    fetchScenarios();
  }, []);

  const fetchScenarios = async () => {
    try {
      setIsLoading(true);
      const res = await fetch('/api/scenarios');
      const data: ScenarioDefinition[] = await res.json();
      setScenarios(data);
      if (data.length > 0 && !selectedScenarioId) {
        setSelectedScenarioId(data[0].id);
      }
    } catch (err: any) {
      console.error('Failed to load scenarios:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const selectedScenario = scenarios.find((s) => s.id === selectedScenarioId) || scenarios[0];

  useEffect(() => {
    setAmazonDraft(selectedScenario?.amazon ? structuredClone(selectedScenario.amazon) : null);
    setPurchaseStart(selectedScenario?.purchaseStart ?? 'END_TO_END');
    setFaultDrafts(structuredClone(selectedScenario?.faults ?? []));
  }, [selectedScenarioId, scenarios]);

  const updateAmazon = <K extends keyof SimulatedAmazonScenario>(key: K, value: SimulatedAmazonScenario[K]) => {
    setAmazonDraft((current) => current ? { ...current, [key]: value } : current);
  };

  const handleCreateRun = async (scenarioId: string) => {
    try {
      setIsLoading(true);
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenarioId,
          ...(selectedScenario?.id === scenarioId && selectedScenario?.phase === 2
            ? { amazon: amazonDraft ?? selectedScenario.amazon, purchaseStart, faults: faultDrafts } : {}) }),
      });
      const response = await res.json();
      if (!res.ok) throw new Error(response.error || `Run creation failed (${res.status}).`);
      const run: SimulationRunRecord = response;
      setActiveRun(run);

      // Fetch initial diff
      const diffRes = await fetch(`/api/runs/${run.runId}/diff`);
      const diffData: StateComparisonDiff = await diffRes.json();
      setDiff(diffData);
      setNotificationMsg(`Run ${run.runId} initialized.`);
    } catch (err: any) {
      console.error('Failed to create run:', err);
      setNotificationMsg(err?.message || 'Run creation failed.');
    } finally {
      setIsLoading(false);
    }
  };

  const addFault = () => setFaultDrafts(current => [...current, {
    id: `fault-${window.crypto.randomUUID()}`,
    targetOp: 'AMAZON_ORDER_SUBMIT', faultType: 'FAIL_BEFORE_COMMIT', triggerOnAttempt: 1,
  }]);

  const updateFault = (index: number, patch: Partial<ScriptedFault>) => setFaultDrafts(current =>
    current.map((fault, i) => i === index ? { ...fault, ...patch } : fault));

  const faultTypesByTarget: Record<ScriptedFault['targetOp'], ScriptedFault['faultType'][]> = {
    VERIFY_SESSION: ['FAIL_BEFORE_COMMIT'], SUBMIT_RESERVATION: ['FAIL_BEFORE_COMMIT','DROP_CONFIRMATION_AFTER_COMMIT'],
    RESOLVE_DEAL: ['FAIL_BEFORE_COMMIT'], TRACKER_READ: ['FAIL_BEFORE_COMMIT','INCOMPLETE_READ'],
    CANCEL_RESERVATION: ['FAIL_BEFORE_COMMIT'], AMAZON_ACCOUNT: ['AUTH_CHALLENGE'],
    AMAZON_SUPPLIER_READ: ['FAIL_BEFORE_COMMIT','INCOMPLETE_READ'], AMAZON_CART_READ: ['CART_STATE_UNKNOWN'],
    AMAZON_CHECKOUT_PREPARE: ['FAIL_BEFORE_COMMIT'],
    AMAZON_ORDER_SUBMIT: ['FAIL_BEFORE_COMMIT','DROP_CONFIRMATION_AFTER_COMMIT','DELAY_VISIBILITY','DUPLICATE_SUBMISSION'],
    AMAZON_ORDER_READ: ['DELAY_VISIBILITY','INCOMPLETE_READ','FAIL_BEFORE_COMMIT'],
    APPLICATION_ORDER_PERSIST: ['APPLICATION_PERSISTENCE_FAILURE'],
  };

  const handleExecute = async () => {
    if (!activeRun) return;
    try {
      setIsExecuting(true);
      const res = await fetch(`/api/runs/${activeRun.runId}/execute`, {
        method: 'POST',
      });
      const data: { run: SimulationRunRecord; diff: StateComparisonDiff; error?: string } = await res.json();
      setActiveRun(data.run);
      setDiff(data.diff);

      if (data.error) {
        setNotificationMsg(`Workflow execution halted: ${data.error}`);
      } else {
        setNotificationMsg(`Workflow executed successfully for run ${data.run.runId}.`);
      }
    } catch (err: any) {
      console.error('Execution failed:', err);
    } finally {
      setIsExecuting(false);
    }
  };

  const handleAdvanceTime = async (seconds: number) => {
    if (!activeRun) return;
    try {
      const res = await fetch(`/api/runs/${activeRun.runId}/advance-time`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds }),
      });
      const { newTime } = await res.json();
      setActiveRun((prev) => (prev ? { ...prev, virtualTime: newTime } : null));
      setNotificationMsg(`Virtual time advanced by ${seconds} seconds.`);
    } catch (err: any) {
      console.error('Failed to advance time:', err);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* Top Bar Contract (3 Zones) */}
      <header className="h-14 border-b border-slate-800 bg-slate-950/80 backdrop-blur px-6 flex items-center justify-between gap-8 shrink-0">
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-base font-semibold tracking-tight text-white whitespace-nowrap">
            BFMR Scenario Studio
          </span>
          <span className="text-xs text-slate-500 font-mono">
            Phase 1–2 · Reservations and Purchases
          </span>
        </div>

        <div className="flex items-center gap-6 text-xs text-slate-400 font-mono">
          <span>BFMR: <strong className="text-emerald-400 font-medium">simulated</strong></span>
          <span className="text-slate-700">|</span>
          <span>Amazon: <strong className="text-emerald-400 font-medium">simulated</strong></span>
          <span className="text-slate-700">|</span>
          <span>Gmail: <strong className="text-slate-300 font-medium">live test</strong></span>
          <span className="text-slate-700">|</span>
          <span>Telegram: <strong className="text-amber-400 font-medium">live [TEST]</strong></span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs font-mono px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-slate-300">
            BFMR_PROVIDER_MODE=simulation
          </span>
        </div>
      </header>

      {/* Main Workspace (3 Columns) */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar: Scenario Catalog & Run Setup */}
        <aside className="w-80 border-r border-slate-800 bg-slate-950 flex flex-col shrink-0">
          <div className="p-4 border-b border-slate-800">
            <h2 className="text-xs font-mono uppercase tracking-wider text-slate-400">
              Scenario Library
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              Select reservation or purchase scenarios.
            </p>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-slate-900">
            {scenarios.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelectedScenarioId(s.id)}
                className={`w-full text-left p-3.5 transition-colors ${
                  selectedScenarioId === s.id
                    ? 'bg-slate-900/90 text-white'
                    : 'text-slate-400 hover:bg-slate-900/40 hover:text-slate-200'
                }`}
              >
                <div className="text-xs font-medium text-slate-200 line-clamp-1">
                  {s.name}
                </div>
                <div className="text-xs text-slate-500 mt-1 line-clamp-2 leading-relaxed">
                  {s.description}
                </div>
                <div className="flex items-center gap-3 mt-2 text-[11px] text-slate-500 font-mono">
                  <span>Deals: {s.initialDeals.length}</span>
                  {s.faults && s.faults.length > 0 && (
                    <span className="text-amber-400">
                      Fault: {s.faults[0].faultType}
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>

          <div className="p-4 border-t border-slate-800 bg-slate-900/40 space-y-3">
            <button
              onClick={() => handleCreateRun(selectedScenarioId)}
              disabled={isLoading}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 rounded transition-colors disabled:opacity-50"
            >
              <RotateCcw className="w-3.5 h-3.5" />
                  <span>Initialize Run from Scenario</span>
            </button>
          </div>
        </aside>

        {/* Center Viewport: Scenario Spec, Run Controller & Comparison Diff */}
        <main className="flex-1 flex flex-col overflow-y-auto bg-slate-950 p-6 space-y-6">
          {notificationMsg && (
            <div className="px-3.5 py-2 rounded bg-slate-900 border border-slate-800 text-xs font-mono text-slate-300 flex items-center justify-between">
              <span>{notificationMsg}</span>
              <button
                onClick={() => setNotificationMsg(null)}
                className="text-slate-500 hover:text-slate-300 ml-4"
              >
                ✕
              </button>
            </div>
          )}

          {/* Active Run Status Strip */}
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-3 border-b border-slate-800/80">
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-base font-semibold text-white">
                    {selectedScenario?.name}
                  </h1>
                  {activeRun && (
                    <span
                      className={`px-2 py-0.5 rounded text-[11px] font-mono font-medium ${
                        activeRun.status === 'COMPLETED'
                          ? 'bg-emerald-950 border border-emerald-700 text-emerald-300'
                          : activeRun.status === 'PAUSED'
                          ? 'bg-amber-950 border border-amber-700 text-amber-300'
                          : activeRun.status === 'FAILED'
                          ? 'bg-rose-950 border border-rose-700 text-rose-300'
                          : activeRun.status === 'RUNNING'
                          ? 'bg-blue-950 border border-blue-700 text-blue-300'
                          : 'bg-slate-800 text-slate-300'
                      }`}
                    >
                      {activeRun.status}
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-400 mt-1 max-w-2xl leading-relaxed">
                  {selectedScenario?.description}
                </p>
              </div>

              {activeRun && (
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => handleAdvanceTime(60)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-mono text-slate-300 bg-slate-950 border border-slate-800 hover:border-slate-700 rounded transition-colors"
                  >
                    <FastForward className="w-3.5 h-3.5" />
                    <span>+60s</span>
                  </button>
                  <button
                    onClick={() => handleAdvanceTime(300)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-mono text-slate-300 bg-slate-950 border border-slate-800 hover:border-slate-700 rounded transition-colors"
                  >
                    <FastForward className="w-3.5 h-3.5" />
                    <span>+5m</span>
                  </button>
                  <button
                    onClick={() => selectedScenario && handleCreateRun(selectedScenario.id)}
                    disabled={isLoading || isExecuting}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-900 border border-slate-700 hover:border-slate-600 rounded transition-colors disabled:opacity-50"
                    title="Initialize a new clean simulation run for this scenario"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>New Run</span>
                  </button>
                  <button
                    onClick={handleExecute}
                    disabled={isExecuting || activeRun.status === 'COMPLETED'}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-500 rounded transition-colors disabled:opacity-50"
                  >
                    <Play className="w-3.5 h-3.5 fill-current" />
                    <span>
                      {isExecuting
                        ? 'Executing...'
                        : activeRun.status === 'COMPLETED'
                        ? 'Completed'
                        : activeRun.status === 'PAUSED'
                        ? 'Resume / reconcile'
                        : 'Run Workflow Step'}
                    </span>
                  </button>
                </div>
              )}
            </div>

            {/* Run Identity & Clocks */}
            {activeRun ? (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-3 text-xs font-mono text-slate-400">
                <div>
                  <span className="text-slate-500">Run ID:</span>{' '}
                  <span className="text-slate-200">{activeRun.runId}</span>
                </div>
                <div>
                  <span className="text-slate-500">Virtual Time:</span>{' '}
                  <span className="text-slate-200 tabular-nums">
                    {new Date(activeRun.virtualTime).toLocaleTimeString()}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500">Isolation:</span>{' '}
                  <span className="text-emerald-400">PGlite Isolated</span>
                </div>
                <div>
                  <span className="text-slate-500">Faults Armed:</span>{' '}
                  <span className={activeRun.activeFaults.length > 0 ? 'text-amber-400' : 'text-slate-400'}>
                    {activeRun.activeFaults.length}
                  </span>
                </div>
              </div>
            ) : (
              <div className="pt-3 flex items-center justify-between text-xs text-slate-500">
                <span>No active run initialized for this scenario.</span>
                <span className="font-mono">Expected: {selectedScenario?.expectedOutcome}</span>
              </div>
            )}
          </div>

          {selectedScenario?.phase === 2 && amazonDraft && (
            <section className="bg-slate-900 border border-slate-800 rounded-lg p-4 space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-xs font-mono uppercase tracking-wider text-slate-300">Purchase Scenario Inputs</h2>
                  <p className="text-xs text-slate-500 mt-1">Inputs apply to the next run. Policy thresholds are fixed by the workflow.</p>
                </div>
                <label className="text-xs text-slate-400 flex items-center gap-2">
                  Start from
                  <select className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200"
                    value={purchaseStart} onChange={e => setPurchaseStart(e.target.value as PurchaseScenarioStart)}>
                    <option value="END_TO_END">New Phase 1 reservation</option>
                    <option value="SEEDED_RESERVATION">Seeded reservation</option>
                  </select>
                </label>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 text-xs">
                <label className="text-slate-400 space-y-1">Synthetic account email
                  <input className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-slate-200" value={amazonDraft.accountEmail}
                    onChange={e => updateAmazon('accountEmail', e.target.value)} />
                </label>
                <label className="text-slate-400 space-y-1">Account state
                  <select className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-slate-200" value={amazonDraft.accountState}
                    onChange={e => updateAmazon('accountState', e.target.value as SimulatedAmazonScenario['accountState'])}>
                    <option value="AUTHENTICATED">Authenticated</option><option value="AUTH_REQUIRED">Login required</option><option value="CHALLENGE">Challenge required</option>
                  </select>
                </label>
                <label className="text-slate-400 space-y-1">ASIN
                  <input maxLength={10} className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-slate-200 font-mono" value={amazonDraft.asin}
                    onChange={e => updateAmazon('asin', e.target.value.toUpperCase())} />
                </label>
                <label className="text-slate-400 space-y-1">Quantity
                  <input type="number" min={1} max={10} className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-slate-200" value={amazonDraft.quantity}
                    onChange={e => updateAmazon('quantity', Number(e.target.value))} />
                </label>

                {([
                  ['itemSubtotalCents', 'Item subtotal (cents)'], ['shippingCents', 'Shipping (cents)'],
                  ['taxCents', 'Tax (cents)'], ['discountCents', 'Discount (cents)'],
                  ['existingUnpaidPayoutCents', 'Existing unpaid payouts (cents)'],
                  ['orderVisibilityDelaySeconds', 'Order visibility delay (seconds)'],
                ] as const).map(([key, label]) => (
                  <label key={key} className="text-slate-400 space-y-1">{label}
                    <input type="number" min={0} className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-slate-200"
                      value={amazonDraft[key] ?? 0} onChange={e => updateAmazon(key, Number(e.target.value) as SimulatedAmazonScenario[typeof key])} />
                  </label>
                ))}

                <label className="text-slate-400 space-y-1">Initial cart state
                  <select className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-slate-200" value={amazonDraft.cartState}
                    onChange={e => updateAmazon('cartState', e.target.value as SimulatedAmazonScenario['cartState'])}>
                    <option value="EMPTY">Empty</option><option value="EXPECTED_ITEM">Expected item only</option><option value="OTHER_ITEMS">Other items present</option><option value="UNKNOWN">Unknown</option>
                  </select>
                </label>
                <label className="text-slate-400 space-y-1">Delivery evidence
                  <select className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-slate-200" value={amazonDraft.deliveryEstimate.type}
                    onChange={e => updateAmazon('deliveryEstimate', { ...amazonDraft.deliveryEstimate, type: e.target.value as SimulatedAmazonScenario['deliveryEstimate']['type'] })}>
                    <option value="ABSENT">Absent</option><option value="KNOWN">Known date</option><option value="UNKNOWN">Ambiguous</option>
                  </select>
                </label>
                <label className="text-slate-400 space-y-1">Delivery evidence text
                  <input className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-slate-200" value={amazonDraft.deliveryEstimate.rawText}
                    onChange={e => updateAmazon('deliveryEstimate', { ...amazonDraft.deliveryEstimate, rawText: e.target.value })} />
                </label>
                <label className="text-slate-400 space-y-1">Latest delivery date
                  <input type="datetime-local" className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-slate-200"
                    value={amazonDraft.deliveryEstimate.latestDate?.slice(0, 16) ?? ''}
                    onChange={e => updateAmazon('deliveryEstimate', { ...amazonDraft.deliveryEstimate,
                      latestDate: e.target.value ? new Date(e.target.value).toISOString() : undefined })} />
                </label>

                {([
                  ['available', 'Product available'], ['isGift', 'Gift selected'], ['isFreeNonPrimeDelivery', 'Free non-Prime delivery'],
                  ['addressMatches', 'Address matches'], ['paymentCardMatches', 'Payment card matches'],
                ] as const).map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2 text-slate-300 bg-slate-950 border border-slate-800 rounded px-3 py-2">
                    <input type="checkbox" checked={amazonDraft[key]} onChange={e => updateAmazon(key, e.target.checked)} />{label}
                  </label>
                ))}
              </div>
              <div className="text-[11px] text-slate-500">Amounts are integer cents. The $100 item cap, payout coverage, $200 exposure cap, gift, delivery, and address/card checks remain application rules.</div>
              <div className="border-t border-slate-800 pt-4 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-xs font-mono uppercase tracking-wider text-slate-300">Scripted faults</h3>
                    <p className="text-[11px] text-slate-500 mt-1">Faults are applied to the next run and trigger on the selected attempt.</p>
                  </div>
                  <button type="button" onClick={addFault} className="px-2.5 py-1.5 rounded bg-slate-800 text-xs text-slate-200 hover:bg-slate-700">Add fault</button>
                </div>
                {faultDrafts.map((fault, index) => (
                  <div key={fault.id} className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-2 items-end bg-slate-950 border border-slate-800 rounded p-3">
                    <label className="text-[11px] text-slate-400 space-y-1">Operation
                      <select className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-slate-200" value={fault.targetOp}
                        onChange={e => {
                          const targetOp = e.target.value as ScriptedFault['targetOp'];
                          updateFault(index, { targetOp, faultType: faultTypesByTarget[targetOp][0] });
                        }}>
                        {Object.keys(faultTypesByTarget).map(target => <option key={target} value={target}>{target.replaceAll('_', ' ')}</option>)}
                      </select>
                    </label>
                    <label className="text-[11px] text-slate-400 space-y-1">Fault behavior
                      <select className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-slate-200" value={fault.faultType}
                        onChange={e => updateFault(index, { faultType: e.target.value as ScriptedFault['faultType'] })}>
                        {faultTypesByTarget[fault.targetOp].map(type => <option key={type} value={type}>{type.replaceAll('_', ' ')}</option>)}
                      </select>
                    </label>
                    <label className="text-[11px] text-slate-400 space-y-1">Trigger on attempt
                      <input type="number" min={1} max={100} className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-slate-200" value={fault.triggerOnAttempt}
                        onChange={e => updateFault(index, { triggerOnAttempt: Number(e.target.value) })} />
                    </label>
                    <label className="text-[11px] text-slate-400 space-y-1">Error detail (optional)
                      <input maxLength={300} className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-slate-200" value={fault.errorDetail ?? ''}
                        onChange={e => updateFault(index, { errorDetail: e.target.value || undefined })} />
                    </label>
                    <button type="button" onClick={() => setFaultDrafts(current => current.filter((_, i) => i !== index))}
                      className="px-2.5 py-1.5 rounded border border-slate-700 text-xs text-slate-300 hover:border-rose-700 hover:text-rose-300">Remove</button>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Dual Store Comparison Matrix & Timeline */}
          {activeRun && (
            <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden flex-1 flex flex-col">
              {/* Tab Navigation */}
              <div className="flex items-center justify-between border-b border-slate-800 px-4 bg-slate-950/60">
                <div className="flex items-center gap-1 py-1.5">
                  <button
                    onClick={() => setActiveTab('diff')}
                    className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                      activeTab === 'diff'
                        ? 'bg-slate-800 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    State Comparison ({diff?.isSynchronized ? 'Synchronized' : 'Discrepancy'})
                  </button>
                  <button
                    onClick={() => setActiveTab('provider')}
                    className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                      activeTab === 'provider'
                        ? 'bg-slate-800 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Provider Truth ({diff?.providerReservations.length ?? 0})
                  </button>
                  <button
                    onClick={() => setActiveTab('app')}
                    className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                      activeTab === 'app'
                        ? 'bg-slate-800 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Application SQL ({diff?.applicationReservations.length ?? 0})
                  </button>
                  <button
                    onClick={() => setActiveTab('logs')}
                    className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                      activeTab === 'logs'
                        ? 'bg-slate-800 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Audit Events ({activeRun.logs.length})
                  </button>
                </div>

                <div className="flex items-center gap-2 text-xs font-mono">
                  {diff?.isSynchronized ? (
                    <span className="flex items-center gap-1.5 text-emerald-400">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>Agreed</span>
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5 text-amber-400">
                      <AlertCircle className="w-3.5 h-3.5" />
                      <span>Uncertainty / Divergence</span>
                    </span>
                  )}
                </div>
              </div>

              {/* Tab Views */}
              <div className="p-4 flex-1 overflow-y-auto">
                {activeTab === 'diff' && (
                  <div className="space-y-4">
                    {/* Discrepancies Callout if any */}
                    {diff && diff.discrepancies.length > 0 && (
                      <div className="p-3 bg-amber-950/40 border border-amber-800 rounded text-xs font-mono space-y-1">
                        <div className="font-semibold text-amber-300 flex items-center gap-1.5">
                          <ShieldAlert className="w-4 h-4" />
                          <span>Discrepancies Observed:</span>
                        </div>
                        {diff.discrepancies.map((d, i) => (
                          <div key={i} className="text-amber-200">
                            Deal {d.dealId} (Reservation: {d.reserveId}): {d.reason}
                          </div>
                        ))}
                      </div>
                    )}

                    {diff && diff.missingInApp.length > 0 && (
                      <div className="p-3 bg-amber-950/40 border border-amber-800 rounded text-xs font-mono space-y-1">
                        <div className="font-semibold text-amber-300 flex items-center gap-1.5">
                          <AlertCircle className="w-4 h-4" />
                          <span>Committed on Provider but Missing in Application DB (Lost Response):</span>
                        </div>
                        {diff.missingInApp.map((p, i) => (
                          <div key={i} className="text-amber-200">
                            Reservation {p.reserveId} for Deal {p.dealId} (Status: {p.status})
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Matched Records Table */}
                    <div>
                      <h3 className="text-xs font-mono uppercase tracking-wider text-slate-400 mb-2">
                        Matched State Records
                      </h3>
                      {diff && diff.matches.length > 0 ? (
                        <table className="w-full text-xs font-mono border-collapse">
                          <thead>
                            <tr className="border-b border-slate-800 text-slate-500 text-left">
                              <th className="py-2 px-3">Reservation ID</th>
                              <th className="py-2 px-3">Deal ID</th>
                              <th className="py-2 px-3">Quantity</th>
                              <th className="py-2 px-3">Provider Status</th>
                              <th className="py-2 px-3">App Status</th>
                              <th className="py-2 px-3">State</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-900 text-slate-300">
                            {diff.matches.map((m) => (
                              <tr key={m.reserveId} className="hover:bg-slate-900/50">
                                <td className="py-2 px-3 text-white">{m.reserveId}</td>
                                <td className="py-2 px-3">{m.dealId}</td>
                                <td className="py-2 px-3 tabular-nums">{m.quantity}</td>
                                <td className="py-2 px-3 text-emerald-400">{m.providerStatus}</td>
                                <td className="py-2 px-3 text-emerald-400">{m.appStatus}</td>
                                <td className="py-2 px-3 text-emerald-400 font-semibold">Matched</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : (
                        <div className="text-xs text-slate-500 py-4 text-center">
                          No matching confirmed records yet. Click &quot;Run Workflow Step&quot; to execute reservation intake.
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {activeTab === 'provider' && (
                  <div>
                    <h3 className="text-xs font-mono uppercase tracking-wider text-slate-400 mb-2">
                      Simulated Provider Reality (sim_reservations)
                    </h3>
                    {diff && diff.providerReservations.length > 0 ? (
                      <table className="w-full text-xs font-mono border-collapse">
                        <thead>
                          <tr className="border-b border-slate-800 text-slate-500 text-left">
                            <th className="py-2 px-3">Reserve ID</th>
                            <th className="py-2 px-3">Deal ID</th>
                            <th className="py-2 px-3">Account</th>
                            <th className="py-2 px-3">Quantity</th>
                            <th className="py-2 px-3">Status</th>
                            <th className="py-2 px-3">Created At</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-900 text-slate-300">
                          {diff.providerReservations.map((p) => (
                            <tr key={p.reserveId}>
                              <td className="py-2 px-3 text-white">{p.reserveId}</td>
                              <td className="py-2 px-3">{p.dealId}</td>
                              <td className="py-2 px-3 text-slate-400">{p.accountId}</td>
                              <td className="py-2 px-3 tabular-nums">{p.quantity}</td>
                              <td className="py-2 px-3 text-blue-400">{p.status}</td>
                              <td className="py-2 px-3 text-slate-500 tabular-nums">
                                {new Date(p.createdAt).toLocaleTimeString()}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <div className="text-xs text-slate-500 py-4 text-center">
                        Zero reservations in simulated provider database.
                      </div>
                    )}
                  </div>
                )}

                {activeTab === 'app' && (
                  <div>
                    <h3 className="text-xs font-mono uppercase tracking-wider text-slate-400 mb-2">
                      Application Test Database (reservations)
                    </h3>
                    {diff && diff.applicationReservations.length > 0 ? (
                      <table className="w-full text-xs font-mono border-collapse">
                        <thead>
                          <tr className="border-b border-slate-800 text-slate-500 text-left">
                            <th className="py-2 px-3">SQL ID</th>
                            <th className="py-2 px-3">BFMR Reserve ID</th>
                            <th className="py-2 px-3">BFMR Deal ID</th>
                            <th className="py-2 px-3">Quantity</th>
                            <th className="py-2 px-3">Payout</th>
                            <th className="py-2 px-3">Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-900 text-slate-300">
                          {diff.applicationReservations.map((a) => (
                            <tr key={a.id}>
                              <td className="py-2 px-3 text-slate-500">{a.id}</td>
                              <td className="py-2 px-3 text-white">{a.bfmrReservationId}</td>
                              <td className="py-2 px-3">{a.dealId}</td>
                              <td className="py-2 px-3 tabular-nums">{a.quantity}</td>
                              <td className="py-2 px-3 tabular-nums">${(a.payoutCents / 100).toFixed(2)}</td>
                              <td className="py-2 px-3 text-emerald-400 font-medium">{a.status}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <div className="text-xs text-slate-500 py-4 text-center">
                        Zero reservations persisted in application SQL store.
                      </div>
                    )}
                  </div>
                )}

                {activeTab === 'logs' && (
                  <div className="space-y-2 font-mono text-xs">
                    {activeRun.logs.map((log, idx) => (
                      <div
                        key={idx}
                        className="p-2 rounded bg-slate-950 border border-slate-900 flex items-start gap-3"
                      >
                        <span className="text-slate-500 tabular-nums shrink-0">
                          {new Date(log.timestamp).toLocaleTimeString()}
                        </span>
                        <span
                          className={`font-semibold shrink-0 ${
                            log.level === 'ERROR'
                              ? 'text-rose-400'
                              : log.level === 'WARN'
                              ? 'text-amber-400'
                              : 'text-blue-400'
                          }`}
                        >
                          [{log.category}]
                        </span>
                        <span className="text-slate-200">{log.message}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Initial Deals in Scenario Preview */}
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 space-y-3">
            <h3 className="text-xs font-mono uppercase tracking-wider text-slate-400">
              Scenario Deal Definition &amp; Target Payload
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {selectedScenario?.initialDeals.map((d) => (
                <div
                  key={d.dealId}
                  className="bg-slate-950 border border-slate-800 rounded p-3 text-xs space-y-1.5"
                >
                  <div className="font-semibold text-white">{d.title}</div>
                  <div className="text-slate-400 font-mono text-[11px] truncate">
                    URL: {d.dealUrl}
                  </div>
                  <div className="flex items-center gap-4 text-slate-400 font-mono text-[11px] pt-1">
                    <span>Retailer: <strong className="text-slate-200">{d.retailer}</strong></span>
                    <span>Payout: <strong className="text-emerald-400">${(d.payoutCents / 100).toFixed(2)}</strong></span>
                    <span>Retail: <strong className="text-slate-300">${(d.retailCents / 100).toFixed(2)}</strong></span>
                    <span>Slots: <strong className="text-slate-200">{d.availableSlots}</strong></span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
