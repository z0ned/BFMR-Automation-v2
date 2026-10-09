import React, { useState } from 'react';
import { 
  Play, 
  CheckCircle2, 
  XCircle, 
  Clock, 
  FlaskConical, 
  ShieldCheck, 
  Terminal, 
  RefreshCw,
  Award
} from 'lucide-react';
import { MILESTONES, INITIAL_TESTS, runAcceptanceTest } from '../services/acceptanceTests';
import { AcceptanceTestResult } from '../types/bfmr';

export const AcceptanceTestView: React.FC = () => {
  const [tests, setTests] = useState<AcceptanceTestResult[]>(INITIAL_TESTS);
  const [selectedTest, setSelectedTest] = useState<AcceptanceTestResult | null>(INITIAL_TESTS[0]);
  const [runningTestId, setRunningTestId] = useState<string | null>(null);
  const [isRunningAll, setIsRunningAll] = useState(false);
  const [filterCategory, setFilterCategory] = useState<string>('ALL');

  const handleRunSingle = async (testId: string) => {
    setRunningTestId(testId);
    try {
      const updated = await runAcceptanceTest(testId);
      setTests((prev) => prev.map((t) => (t.id === testId ? updated : t)));
      if (selectedTest?.id === testId) {
        setSelectedTest(updated);
      }
    } finally {
      setRunningTestId(null);
    }
  };

  const handleRunAll = async () => {
    setIsRunningAll(true);
    try {
      for (const t of tests) {
        setRunningTestId(t.id);
        const updated = await runAcceptanceTest(t.id);
        setTests((prev) => prev.map((item) => (item.id === t.id ? updated : item)));
        if (selectedTest?.id === t.id) {
          setSelectedTest(updated);
        }
      }
    } finally {
      setIsRunningAll(false);
      setRunningTestId(null);
    }
  };

  const filteredTests = tests.filter((t) => {
    if (filterCategory === 'ALL') return true;
    return t.category === filterCategory;
  });

  const passedCount = tests.filter((t) => t.status === 'PASSED').length;

  return (
    <div className="space-y-6">
      {/* Top Milestones Section */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
        <div className="flex flex-col md:flex-row md:items-center justify-between mb-4 gap-3">
          <div>
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <Award className="w-5 h-5 text-indigo-400" />
              Solution Design v1.5 Milestones (M0 – M5)
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Evidence gates and progressive validation requirements from docs/IMPLEMENTATION_PLAN.md
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-1 rounded-md">
              {passedCount} / {tests.length} AT Scenarios Passing
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {MILESTONES.map((m) => (
            <div
              key={m.id}
              className="p-3 bg-slate-950/80 border border-slate-800 rounded-lg flex flex-col justify-between"
            >
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="font-mono text-xs font-bold text-indigo-400">{m.id}</span>
                  <span className="px-1.5 py-0.2 text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded">
                    {m.status}
                  </span>
                </div>
                <div className="text-xs font-semibold text-slate-200 line-clamp-1">{m.title}</div>
                <div className="text-[11px] text-slate-400 mt-1 line-clamp-2">{m.description}</div>
              </div>
              <div className="mt-2 pt-2 border-t border-slate-800/80 text-[10px] text-slate-500 font-mono">
                {m.tests.join(', ')}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Test Controls & Test List */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: Filterable Tests Table */}
        <div className="lg:col-span-7 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <FlaskConical className="w-5 h-5 text-blue-400" />
              <h3 className="text-base font-semibold text-white">Acceptance Tests</h3>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={isRunningAll}
                onClick={handleRunAll}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold shadow-sm transition-all cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isRunningAll ? 'animate-spin' : ''}`} />
                <span>Run All Verification</span>
              </button>
            </div>
          </div>

          {/* Filter Pills */}
          <div className="flex flex-wrap gap-1.5 pt-1">
            {['ALL', 'INTAKE', 'TRACKER', 'ORCHESTRATION', 'BROWSER', 'OPERATIONS'].map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setFilterCategory(cat)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                  filterCategory === cat
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>

          {/* Test Items */}
          <div className="space-y-2 max-h-[520px] overflow-y-auto pr-1">
            {filteredTests.map((test) => {
              const isSelected = selectedTest?.id === test.id;
              const isRunning = runningTestId === test.id;

              return (
                <div
                  key={test.id}
                  onClick={() => setSelectedTest(test)}
                  className={`p-3 rounded-lg border cursor-pointer transition-all ${
                    isSelected
                      ? 'bg-slate-800 border-blue-500/60 shadow-sm'
                      : 'bg-slate-950/60 border-slate-800/80 hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-bold text-blue-400 bg-blue-500/10 px-1.5 py-0.5 rounded border border-blue-500/20">
                        {test.id}
                      </span>
                      <span className="text-xs font-semibold text-slate-200">{test.title}</span>
                    </div>

                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        test.status === 'PASSED'
                          ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                          : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                      }`}>
                        {test.status}
                      </span>

                      <button
                        type="button"
                        disabled={isRunning || isRunningAll}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRunSingle(test.id);
                        }}
                        className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 disabled:opacity-40"
                        title="Re-run test"
                      >
                        <Play className={`w-3 h-3 ${isRunning ? 'animate-pulse text-blue-400' : ''}`} />
                      </button>
                    </div>
                  </div>

                  <p className="text-[11px] text-slate-400 line-clamp-1">{test.description}</p>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: Detailed Evidence & Audit Inspector */}
        <div className="lg:col-span-5 bg-slate-900 border border-slate-800 rounded-xl p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-3">
              <h3 className="text-sm font-semibold text-slate-200 uppercase tracking-wider flex items-center gap-2">
                <Terminal className="w-4 h-4 text-blue-400" />
                <span>Evidence & Assertion Log</span>
              </h3>
              {selectedTest && (
                <span className="text-xs font-mono text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded border border-indigo-500/20">
                  {selectedTest.milestone}
                </span>
              )}
            </div>

            {selectedTest ? (
              <div className="space-y-3">
                <div>
                  <div className="text-xs text-slate-400 font-mono">Test ID & Title:</div>
                  <div className="text-sm font-bold text-white mt-0.5">
                    {selectedTest.id}: {selectedTest.title}
                  </div>
                </div>

                <div>
                  <div className="text-xs text-slate-400 font-mono">Specification Scope:</div>
                  <div className="text-xs text-slate-300 bg-slate-950 p-2 rounded border border-slate-800 mt-1 leading-relaxed">
                    {selectedTest.description}
                  </div>
                </div>

                <div>
                  <div className="text-xs text-slate-400 font-mono mb-1">Execution Evidence / Logs:</div>
                  <div className="bg-slate-950 border border-slate-800 rounded-lg p-3 font-mono text-xs space-y-1.5 text-slate-300 max-h-[300px] overflow-y-auto">
                    {selectedTest.evidenceLogs.map((log, idx) => (
                      <div key={idx} className="flex items-start gap-1.5">
                        <span className="text-emerald-500 select-none">›</span>
                        <span className="text-slate-300 leading-relaxed">{log}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {selectedTest.lastRun && (
                  <div className="text-[11px] text-slate-500 font-mono flex items-center gap-1">
                    <Clock className="w-3.5 h-3.5" />
                    <span>Last run: {new Date(selectedTest.lastRun).toLocaleString()}</span>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-xs text-slate-500 py-10 text-center">Select a test scenario to inspect evidence.</p>
            )}
          </div>

          {selectedTest && (
            <div className="pt-4 border-t border-slate-800 mt-4">
              <button
                type="button"
                disabled={runningTestId === selectedTest.id || isRunningAll}
                onClick={() => handleRunSingle(selectedTest.id)}
                className="w-full py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-semibold flex items-center justify-center gap-2 border border-slate-700 transition-colors cursor-pointer"
              >
                <Play className="w-3.5 h-3.5" />
                <span>Re-verify {selectedTest.id} Now</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
