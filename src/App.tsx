import React, { useState, useEffect } from 'react';
import { Header } from './components/Header';
import { PipelineView } from './components/PipelineView';
import { AcceptanceTestView } from './components/AcceptanceTestView';
import { TrackerView } from './components/TrackerView';
import { OperatorCliView } from './components/OperatorCliView';
import { IncidentsView } from './components/IncidentsView';
import { SpecsView } from './components/SpecsView';
import { orchestrator } from './services/orchestrator';

export function App() {
  const [activeTab, setActiveTab] = useState<string>('pipeline');
  const [status, setStatus] = useState(orchestrator.currentStatus);
  const [historyId, setHistoryId] = useState(orchestrator.currentHistoryId);
  const [isLocked, setIsLocked] = useState(orchestrator.isWorkerLocked);
  const [incidentCount, setIncidentCount] = useState(
    orchestrator.incidents.filter((i) => !i.resolved).length
  );
  const [, setTick] = useState(0);

  useEffect(() => {
    const unsubscribe = orchestrator.subscribe(() => {
      setStatus(orchestrator.currentStatus);
      setHistoryId(orchestrator.currentHistoryId);
      setIsLocked(orchestrator.isWorkerLocked);
      setIncidentCount(orchestrator.incidents.filter((i) => !i.resolved).length);
      setTick((t) => t + 1);
    });
    return unsubscribe;
  }, []);

  const handleRefresh = () => {
    setStatus(orchestrator.currentStatus);
    setHistoryId(orchestrator.currentHistoryId);
    setIsLocked(orchestrator.isWorkerLocked);
    setIncidentCount(orchestrator.incidents.filter((i) => !i.resolved).length);
    setTick((t) => t + 1);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      <div role="status" className="bg-amber-950 text-amber-200 p-4">Demonstration mode — all displayed activity is simulated. Live service disconnected; operational status unknown.</div>
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        status={status}
        historyId={historyId}
        isLocked={isLocked}
        incidentCount={incidentCount}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {activeTab === 'pipeline' && (
          <PipelineView status={status} onRefresh={handleRefresh} />
        )}
        {activeTab === 'tests' && <AcceptanceTestView />}
        {activeTab === 'tracker' && <TrackerView onRefresh={handleRefresh} />}
        {activeTab === 'cli' && <OperatorCliView />}
        {activeTab === 'incidents' && <IncidentsView onRefresh={handleRefresh} />}
        {activeTab === 'specs' && <SpecsView />}
      </main>

      {/* Persistent Footer */}
      <footer className="border-t border-slate-900 bg-slate-950/80 py-4 mt-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between text-xs text-slate-500 gap-2">
          <div className="flex items-center space-x-2">
            <span className="font-semibold text-slate-400">BFMR Automation v2 Control Center</span>
            <span>•</span>
            <span>Authoritative Baseline: Solution Design Specification v1.5</span>
          </div>
          <div className="flex items-center space-x-4 font-mono">
            <span>Live browser status unknown</span>
            <span>•</span>
            <span>Demo data in browser memory</span>
            <span>•</span>
            <span>Port 3000</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default App;
