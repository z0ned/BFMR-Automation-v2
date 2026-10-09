import React, { useState } from 'react';
import { 
  ShieldCheck, 
  Trash2, 
  Plus, 
  ExternalLink, 
  Clock, 
  AlertCircle, 
  RefreshCw,
  UserCheck,
  Bot
} from 'lucide-react';
import { myTrackerService } from '../services/myTracker';
import { ReservationRecord } from '../types/bfmr';

interface TrackerViewProps {
  onRefresh: () => void;
}

export const TrackerView: React.FC<TrackerViewProps> = ({ onRefresh }) => {
  const [reservations, setReservations] = useState<ReservationRecord[]>(() =>
    myTrackerService.getAllReservations()
  );
  const [manualTitle, setManualTitle] = useState('');
  const [manualDealId, setManualDealId] = useState('');
  const [manualRetailer, setManualRetailer] = useState('Amazon');
  const [isAdding, setIsAdding] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refreshList = () => {
    setReservations(myTrackerService.getAllReservations());
    onRefresh();
  };

  const handleManualRelease = (rid: string) => {
    const ok = myTrackerService.manualReleaseReservation(rid);
    if (ok) {
      setMsg(`Reservation ${rid} released manually by Matt.`);
      refreshList();
    }
  };

  const handleAddManualReservation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualDealId || !manualTitle) return;
    
    await myTrackerService.recordReservation({
      canonicalDealId: manualDealId.trim().toLowerCase(),
      title: manualTitle.trim(),
      retailer: manualRetailer,
      colorVariant: 'Black',
      source: 'MANUAL_WEB',
    });

    setManualDealId('');
    setManualTitle('');
    setIsAdding(false);
    setMsg('Manual reservation created. This will now block duplicate automated submissions.');
    refreshList();
  };

  const handleResetDefaults = () => {
    myTrackerService.resetToDefault();
    setMsg('Reset My Tracker store to default baseline.');
    refreshList();
  };

  const activeReservations = reservations.filter((r) => r.status === 'ACTIVE');

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-white flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-emerald-400" />
              My Tracker Contract & Reservation Store
            </h2>
            <p className="text-sm text-slate-400 mt-1">
              Read and verify active reservations. Used to enforce duplicate prevention and Matt's manual release model.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleResetDefaults}
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-medium border border-slate-700 transition-colors cursor-pointer"
            >
              Reset Sample Data
            </button>
            <button
              type="button"
              onClick={() => setIsAdding(!isAdding)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-semibold shadow-sm transition-all cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Manual Reservation</span>
            </button>
          </div>
        </div>

        {/* Notice on Matt's Manual Release Rule */}
        <div className="mt-4 p-3 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-300 flex items-start gap-2.5">
          <AlertCircle className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
          <div className="leading-relaxed">
            <span className="font-semibold text-white">Authoritative v1.5 Release Rule: </span>
            Matt releases reservations manually. There is strictly NO one-minute countdown release, NO failed-eligibility cancellation, and NO automated release API in MVP 1.
          </div>
        </div>
      </div>

      {msg && (
        <div className="p-3 bg-blue-950/40 border border-blue-500/40 text-blue-300 rounded-lg text-xs flex items-center justify-between">
          <span>{msg}</span>
          <button onClick={() => setMsg(null)} className="text-blue-400 hover:text-white">✕</button>
        </div>
      )}

      {/* Manual Addition Form Modal/Card */}
      {isAdding && (
        <form onSubmit={handleAddManualReservation} className="bg-slate-900 border border-blue-500/40 rounded-xl p-5 space-y-3">
          <h3 className="text-sm font-semibold text-white">Create Manual Reservation (Test Duplicate Blocker)</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Canonical Deal ID</label>
              <input
                type="text"
                placeholder="e.g. airpods-max-silver"
                value={manualDealId}
                onChange={(e) => setManualDealId(e.target.value)}
                required
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 font-mono focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Deal Title</label>
              <input
                type="text"
                placeholder="e.g. Apple AirPods Max - Silver"
                value={manualTitle}
                onChange={(e) => setManualTitle(e.target.value)}
                required
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Retailer</label>
              <select
                value={manualRetailer}
                onChange={(e) => setManualRetailer(e.target.value)}
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:border-blue-500"
              >
                <option value="Amazon">Amazon</option>
                <option value="Best Buy">Best Buy</option>
                <option value="Target">Target</option>
                <option value="Walmart">Walmart</option>
                <option value="Costco">Costco</option>
              </select>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setIsAdding(false)}
              className="px-3 py-1.5 bg-slate-800 text-slate-300 rounded-lg text-xs"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-semibold"
            >
              Save Reservation
            </button>
          </div>
        </form>
      )}

      {/* Reservations Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-white">Tracked Reservations</span>
            <span className="text-xs font-mono text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
              {activeReservations.length} Active
            </span>
          </div>
          <button onClick={refreshList} className="text-xs text-slate-400 hover:text-slate-200 flex items-center gap-1">
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh</span>
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950/80 text-slate-400 font-mono border-b border-slate-800">
              <tr>
                <th className="py-3 px-4">Reservation ID (RID)</th>
                <th className="py-3 px-4">Canonical Deal ID</th>
                <th className="py-3 px-4">Title & Retailer</th>
                <th className="py-3 px-4">Quantity</th>
                <th className="py-3 px-4">Origin Source</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-right">Matt's Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 text-slate-300">
              {reservations.map((r) => (
                <tr key={r.rid} className="hover:bg-slate-800/40 transition-colors">
                  <td className="py-3 px-4 font-mono font-medium text-blue-400">{r.rid}</td>
                  <td className="py-3 px-4 font-mono text-slate-400">{r.canonicalDealId}</td>
                  <td className="py-3 px-4">
                    <div className="font-medium text-slate-200">{r.title}</div>
                    <div className="text-[11px] text-slate-500 font-mono">{r.retailer} • Variant: {r.colorVariant}</div>
                  </td>
                  <td className="py-3 px-4 font-mono font-bold text-slate-200">{r.quantity} offer</td>
                  <td className="py-3 px-4">
                    {r.createdAtSource === 'AUTOMATION_MVP1' ? (
                      <span className="flex items-center gap-1 text-[11px] text-blue-400">
                        <Bot className="w-3.5 h-3.5" /> Automation
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-[11px] text-amber-400">
                        <UserCheck className="w-3.5 h-3.5" /> Manual Web
                      </span>
                    )}
                  </td>
                  <td className="py-3 px-4">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                      r.status === 'ACTIVE'
                        ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                        : 'bg-slate-800 text-slate-400 border border-slate-700'
                    }`}>
                      {r.status}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-right">
                    {r.status === 'ACTIVE' ? (
                      <button
                        type="button"
                        onClick={() => handleManualRelease(r.rid)}
                        className="px-2.5 py-1 bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 border border-rose-600/40 rounded text-[11px] font-medium transition-colors cursor-pointer"
                        title="Release this reservation manually"
                      >
                        Release Manually
                      </button>
                    ) : (
                      <span className="text-[11px] text-slate-500 italic">Released</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
