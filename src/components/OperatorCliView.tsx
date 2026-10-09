import React, { useState, useRef, useEffect } from 'react';
import { Terminal, Send, Trash2, HelpCircle } from 'lucide-react';
import { orchestrator } from '../services/orchestrator';
import { myTrackerService } from '../services/myTracker';
import { runAcceptanceTest } from '../services/acceptanceTests';

export const OperatorCliView: React.FC = () => {
  const [inputCmd, setInputCmd] = useState('');
  const [history, setHistory] = useState<Array<{ command?: string; output: string; time: string }>>([
    {
      output: 'BFMR Automation v2 Operator Interactive CLI (Ubuntu Headed Node.js Host)\nType "help" to view available diagnostic and recovery commands.',
      time: new Date().toLocaleTimeString(),
    },
  ]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history]);

  const executeCommand = async (raw: string) => {
    const cmd = raw.trim();
    if (!cmd) return;

    const parts = cmd.split(/\s+/);
    const action = parts[0].toLowerCase();
    const args = parts.slice(1);
    let output = '';

    switch (action) {
      case 'help':
        output = `Available BFMR CLI Commands:
  status                 - Show worker lock, Gmail cursor, active pipeline state
  tracker                - List active reservations from My Tracker store
  release <RID>          - Manually release a reservation by RID (e.g. release RID-884912)
  lock                   - Acquire singleton worker lock
  unlock                 - Release singleton worker lock
  cursor status          - View Gmail historyId and last sync timestamp
  cursor reset           - Reset Gmail cursor to healthy baseline
  cursor expire          - Simulate expired cursor fault (OQ-001 boundary test)
  incidents              - List recent operational incidents & Telegram alert outbox
  test <ID>              - Execute acceptance test (e.g. test AT-01, test AT-04)
  clear                  - Clear terminal screen`;
        break;

      case 'status':
        output = `Worker Status:
  Owner: ${orchestrator.workerOwnerId}
  Locked: ${orchestrator.isWorkerLocked ? 'YES (Active operation in-flight)' : 'NO (Idle)'}
  Current Pipeline State: ${orchestrator.currentStatus}
  Gmail History Cursor: ${orchestrator.currentHistoryId}
  Last Sync: ${orchestrator.lastSyncTimestamp}
  Cursor Expired Fault: ${orchestrator.cursorExpiredFault ? 'ACTIVE (Halts intake)' : 'NORMAL'}
  Active In-Flight Attempts: ${orchestrator.currentAttempts.length}
  Total Processed Messages: ${orchestrator.processedEmails.length}`;
        break;

      case 'tracker': {
        const active = myTrackerService.getActiveReservations();
        if (active.length === 0) {
          output = 'No active reservations currently in My Tracker.';
        } else {
          output = `Active Reservations in My Tracker (${active.length}):\n` +
            active.map((r) => `  • ${r.rid} | Deal: ${r.canonicalDealId} | Qty: ${r.quantity} | Source: ${r.createdAtSource} | Reserved: ${new Date(r.reservedAt).toLocaleTimeString()}`).join('\n');
        }
        break;
      }

      case 'release': {
        const rid = args[0];
        if (!rid) {
          output = 'Error: Please specify RID. Example: release RID-884912';
        } else {
          const ok = myTrackerService.manualReleaseReservation(rid);
          output = ok 
            ? `Success: Reservation ${rid} released manually by Matt.`
            : `Error: RID '${rid}' not found or already released.`;
        }
        break;
      }

      case 'lock': {
        const ok = orchestrator.acquireLock();
        output = ok 
          ? 'Acquired singleton worker lock.' 
          : 'Failed: Worker is already locked.';
        break;
      }

      case 'unlock': {
        orchestrator.releaseLock();
        output = 'Released singleton worker lock.';
        break;
      }

      case 'cursor': {
        const sub = args[0]?.toLowerCase();
        if (sub === 'reset') {
          orchestrator.resetCursor();
          output = `Gmail history cursor reset to 104250. Cursor expired fault cleared.`;
        } else if (sub === 'expire') {
          orchestrator.setCursorExpiredFault(true);
          output = `Simulated expired Gmail cursor fault. Intake pipeline will halt per OQ-001 boundary.`;
        } else {
          output = `Gmail Cursor Status:
  Current historyId: ${orchestrator.currentHistoryId}
  Last Sync: ${orchestrator.lastSyncTimestamp}
  Expired Fault: ${orchestrator.cursorExpiredFault ? 'FAULT ACTIVE' : 'OK'}`;
        }
        break;
      }

      case 'incidents': {
        if (orchestrator.incidents.length === 0) {
          output = 'No recorded incidents.';
        } else {
          output = `Recent Incidents (${orchestrator.incidents.length}):\n` +
            orchestrator.incidents.map((i) => `  [${i.level}] ${i.id} - ${i.title}: ${i.detail}`).join('\n');
        }
        break;
      }

      case 'test': {
        const testId = (args[0] || '').toUpperCase();
        if (!testId) {
          output = 'Error: Specify test ID. E.g., "test AT-01"';
        } else {
          try {
            const res = await runAcceptanceTest(testId);
            output = `Test ${res.id} (${res.title}): ${res.status}\n` + res.evidenceLogs.map((l) => `  › ${l}`).join('\n');
          } catch (e: any) {
            output = `Error executing test ${testId}: ${e?.message || e}`;
          }
        }
        break;
      }

      case 'clear':
        setHistory([]);
        return;

      default:
        output = `Command not recognized: "${action}". Type "help" for command list.`;
    }

    setHistory((prev) => [
      ...prev,
      {
        command: cmd,
        output,
        time: new Date().toLocaleTimeString(),
      },
    ]);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputCmd.trim()) return;
    const cmd = inputCmd;
    setInputCmd('');
    executeCommand(cmd);
  };

  return (
    <div className="space-y-4">
      {/* Banner */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <Terminal className="w-5 h-5 text-emerald-400" />
            Operator CLI & Recovery Console
          </h2>
          <p className="text-sm text-slate-400 mt-1">
            Local administrative command-line interface for monitoring, unlocking, releasing reservations, and cursor reconciliation.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setHistory([])}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-medium border border-slate-700 transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5" />
          <span>Clear Screen</span>
        </button>
      </div>

      {/* Terminal Window */}
      <div className="bg-slate-950 border border-slate-800 rounded-xl overflow-hidden shadow-2xl flex flex-col h-[560px]">
        {/* Terminal Header */}
        <div className="bg-slate-900 px-4 py-2 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <div className="w-3 h-3 rounded-full bg-rose-500/80" />
            <div className="w-3 h-3 rounded-full bg-amber-500/80" />
            <div className="w-3 h-3 rounded-full bg-emerald-500/80" />
            <span className="text-xs text-slate-400 font-mono ml-2">bash - bfmr-ops@ubuntu-dedicated</span>
          </div>
          <span className="text-xs text-slate-500 font-mono">v1.5 Operator CLI</span>
        </div>

        {/* Terminal Output Log */}
        <div className="flex-1 p-4 overflow-y-auto font-mono text-xs text-slate-300 space-y-3 selection:bg-blue-600">
          {history.map((item, idx) => (
            <div key={idx} className="space-y-1">
              {item.command && (
                <div className="flex items-center gap-2 text-blue-400 font-bold">
                  <span className="text-emerald-400">bfmr-ops@ubuntu:~$</span>
                  <span>{item.command}</span>
                </div>
              )}
              <pre className="text-slate-300 whitespace-pre-wrap leading-relaxed pl-2 font-mono border-l border-slate-800">
                {item.output}
              </pre>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {/* Input Bar */}
        <form onSubmit={handleSubmit} className="p-3 bg-slate-900/90 border-t border-slate-800 flex items-center gap-2">
          <span className="text-emerald-400 font-mono text-xs pl-2 font-bold select-none">bfmr-ops@ubuntu:~$</span>
          <input
            type="text"
            value={inputCmd}
            onChange={(e) => setInputCmd(e.target.value)}
            placeholder="Type 'help' or command (e.g. status, tracker, release RID-884912)..."
            className="flex-1 bg-transparent border-0 text-white font-mono text-xs focus:outline-none placeholder:text-slate-600"
          />
          <button
            type="submit"
            className="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded text-xs font-mono font-medium flex items-center gap-1 cursor-pointer"
          >
            <Send className="w-3 h-3" />
            <span>Exec</span>
          </button>
        </form>
      </div>
    </div>
  );
};
