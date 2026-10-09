import React from 'react';
import { Bell, AlertTriangle, CheckCircle2, ShieldAlert, Send, Trash2, ExternalLink } from 'lucide-react';
import { orchestrator } from '../services/orchestrator';
import { Incident } from '../types/bfmr';

interface IncidentsViewProps {
  onRefresh: () => void;
}

export const IncidentsView: React.FC<IncidentsViewProps> = ({ onRefresh }) => {
  const incidents = orchestrator.incidents;

  const handleClearAll = () => {
    orchestrator.clearIncidents();
    onRefresh();
  };

  const handleResolve = (id: string) => {
    const inc = orchestrator.incidents.find((i) => i.id === id);
    if (inc) {
      inc.resolved = true;
      onRefresh();
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <Bell className="w-5 h-5 text-amber-400" />
            Operational Incidents & Telegram Outbox
          </h2>
          <p className="text-sm text-slate-400 mt-1">
            Real-time incident dispatching. Critical alerts (uncertain outcomes, expired cursors, lock contention) sent to Telegram bot.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleClearAll}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-medium border border-slate-700 transition-colors cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Clear Incidents</span>
          </button>
        </div>
      </div>

      {/* Telegram Outbox Card */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
        <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-4">
          <div className="flex items-center gap-2">
            <Send className="w-4 h-4 text-blue-400" />
            <h3 className="text-sm font-semibold text-white">Telegram Bot Gateway Status</h3>
          </div>
          <span className="text-xs font-mono text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
            Connected (Private Chat)
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
          <div className="p-3 bg-slate-950 border border-slate-800 rounded-lg">
            <div className="text-slate-400 font-mono">Telegram Bot:</div>
            <div className="font-semibold text-slate-200 mt-1">@BFMR_Automation_Alert_Bot</div>
          </div>
          <div className="p-3 bg-slate-950 border border-slate-800 rounded-lg">
            <div className="text-slate-400 font-mono">Recipient Channel:</div>
            <div className="font-semibold text-slate-200 mt-1">Matt Private Ops Chat ID: -1004928172</div>
          </div>
          <div className="p-3 bg-slate-950 border border-slate-800 rounded-lg">
            <div className="text-slate-400 font-mono">Notification Outbox Rate:</div>
            <div className="font-semibold text-slate-200 mt-1">Immediate (Zero Delay on Critical)</div>
          </div>
        </div>
      </div>

      {/* Incident Cards */}
      <div className="space-y-3">
        {incidents.length === 0 ? (
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-8 text-center text-slate-400 text-xs">
            No active incidents. Automation is operating within nominal parameters.
          </div>
        ) : (
          incidents.map((inc) => (
            <div
              key={inc.id}
              className={`p-4 rounded-xl border transition-all ${
                inc.level === 'CRITICAL'
                  ? 'bg-rose-950/20 border-rose-500/40'
                  : inc.level === 'WARNING'
                  ? 'bg-amber-950/20 border-amber-500/40'
                  : 'bg-slate-900 border-slate-800'
              }`}
            >
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-2">
                  {inc.level === 'CRITICAL' ? (
                    <ShieldAlert className="w-4 h-4 text-rose-400" />
                  ) : inc.level === 'WARNING' ? (
                    <AlertTriangle className="w-4 h-4 text-amber-400" />
                  ) : (
                    <Bell className="w-4 h-4 text-blue-400" />
                  )}
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                    inc.level === 'CRITICAL'
                      ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                      : inc.level === 'WARNING'
                      ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                      : 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                  }`}>
                    {inc.level}
                  </span>
                  <span className="font-semibold text-sm text-white">{inc.title}</span>
                  <span className="font-mono text-xs text-slate-500">[{inc.id}]</span>
                </div>

                <div className="flex items-center gap-3 text-xs">
                  <span className="text-slate-400 font-mono">{new Date(inc.timestamp).toLocaleTimeString()}</span>
                  <span className="flex items-center gap-1 text-emerald-400 font-mono text-[11px]">
                    <Send className="w-3 h-3" />
                    <span>Telegram Dispatched</span>
                  </span>
                  {!inc.resolved && (
                    <button
                      type="button"
                      onClick={() => handleResolve(inc.id)}
                      className="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-[11px] font-medium border border-slate-700 cursor-pointer"
                    >
                      Mark Resolved
                    </button>
                  )}
                </div>
              </div>

              <p className="text-xs text-slate-300 leading-relaxed pl-6">{inc.detail}</p>
              
              {inc.relatedDealId && (
                <div className="mt-2 pl-6 flex items-center gap-2 text-[11px] text-slate-400 font-mono">
                  <span>Related Deal:</span>
                  <span className="text-blue-400 bg-blue-500/10 px-1.5 py-0.5 rounded border border-blue-500/20">
                    {inc.relatedDealId}
                  </span>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};
