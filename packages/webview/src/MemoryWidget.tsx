
export interface MemorySummary {
  file: string;
  updated: string | null;
  next: string | null;
  latest: string | null;
}

/** "5 min ago", "2 h ago", "3 d ago". */
export function ago(iso: string, now: Date): string {
  const s = Math.max(0, (now.getTime() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/**
 * Session memory, in the board's top-left corner above the first column: when
 * it was last updated and what's next. Click to open it in the editor.
 */
export function MemoryWidget({ memory, onOpen }: { memory: MemorySummary; onOpen: () => void }) {
  const empty = !memory.updated;
  return (
    <button type="button" className="memory" onClick={onOpen} title="Open the session memory">
      <span className="memory-head">
        <span className="memory-title">Session</span>
        <span className="memory-age">{empty ? 'nothing saved yet' : ago(memory.updated!, new Date())}</span>
      </span>
      <span className="memory-next">
        {empty ? (
          'Agents save where the work stands here. In Claude Code: /session-memory'
        ) : memory.next ? (
          <>
            <strong>Next:</strong> {memory.next}
          </>
        ) : (
          'Open to read the latest entry.'
        )}
      </span>
    </button>
  );
}
