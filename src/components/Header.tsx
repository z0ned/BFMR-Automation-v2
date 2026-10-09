import React from 'react';
import { 
  ShieldCheck, 
  Terminal, 
  FlaskConical, 
  Workflow, 
  Bell, 
  FileText,
  Lock,
  Unlock,
  Radio,
  Clock
} from 'lucide-react';
import { PipelineStatus } from '../types/bfmr';

interface HeaderProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  status: PipelineStatus;
  historyId: number;
  isLocked: boolean;
  incidentCount: number;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  setActiveTab,
  status,
  historyId,
  isLocked,
  incidentCount,
}) => {
  return (
    <header className="border-b border-slate-800 bg-slate-900/90 backdrop-blur sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo & Identity */}
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-blue-600 to-indigo-700 flex items-center justify-center shadow-lg shadow-blue-500/20">
              <ShieldCheck className="w-6 h-6 text-white" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="font-bold text-lg text-white tracking-tight">BFMR Automation</span>
                <span className="px-1.5 py-0.5 text-xs font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded">
                  v2.0 (v1.5 Spec)
                </span>
              </div>
              <p className="text-xs text-slate-400">Headed Chromium • Local PostgreSQL • Gmail Intake</p>
            </div>
          </div>

          {/* Operational Status Badges */}
          <div className="hidden md:flex items-center space-x-4">
            {/* Singleton Lock */}
            <div className={`flex items-center space-x-1.5 px-2.5 py-1 rounded-md text-xs font-medium border ${
              isLocked 
                ? 'bg-amber-500/10 border-amber-500/30 text-amber-400' 
                : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
            }`}>
              {isLocked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
              <span>{isLocked ? 'Worker Locked (Active)' : 'Singleton Idle'}</span>
            </div>

            {/* Gmail Cursor */}
            <div className="flex items-center space-x-1.5 px-2.5 py-1 bg-slate-800 border border-slate-700 rounded-md text-xs text-slate-300 font-mono">
              <Clock className="w-3.5 h-3.5 text-blue-400" />
              <span>historyId: {historyId}</span>
            </div>

            {/* Pipeline Stage */}
            <div className="flex items-center space-x-1.5 px-2.5 py-1 bg-slate-800/80 border border-slate-700/80 rounded-md text-xs font-medium">
              <Radio className={`w-3.5 h-3.5 ${status !== 'IDLE' ? 'text-amber-400 animate-pulse' : 'text-slate-400'}`} />
              <span className="text-slate-300">State:</span>
              <span className="text-blue-400 font-mono uppercase">{status}</span>
            </div>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="flex space-x-1 overflow-x-auto py-2 border-t border-slate-800/60 no-scrollbar">
          <button
            onClick={() => setActiveTab('pipeline')}
            className={`flex items-center space-x-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              activeTab === 'pipeline'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
          >
            <Workflow className="w-4 h-4" />
            <span>Live Automation Pipeline</span>
          </button>

          <button
            onClick={() => setActiveTab('tests')}
            className={`flex items-center space-x-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              activeTab === 'tests'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
          >
            <FlaskConical className="w-4 h-4" />
            <span>Acceptance Tests (AT-01–23)</span>
          </button>

          <button
            onClick={() => setActiveTab('tracker')}
            className={`flex items-center space-x-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              activeTab === 'tracker'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
          >
            <ShieldCheck className="w-4 h-4" />
            <span>My Tracker & Reservations</span>
          </button>

          <button
            onClick={() => setActiveTab('cli')}
            className={`flex items-center space-x-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              activeTab === 'cli'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
          >
            <Terminal className="w-4 h-4" />
            <span>Operator CLI & Console</span>
          </button>

          <button
            onClick={() => setActiveTab('incidents')}
            className={`flex items-center space-x-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors relative ${
              activeTab === 'incidents'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
          >
            <Bell className="w-4 h-4" />
            <span>Incidents & Telegram</span>
            {incidentCount > 0 && (
              <span className="ml-1 px-1.5 py-0.2 text-xs bg-rose-500/20 text-rose-300 border border-rose-500/30 rounded-full font-mono">
                {incidentCount}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('specs')}
            className={`flex items-center space-x-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              activeTab === 'specs'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
          >
            <FileText className="w-4 h-4" />
            <span>Specification & Decisions</span>
          </button>
        </div>
      </div>
    </header>
  );
};
