import type { CardView, ViewSettings } from '@kanban-bananas/core';
import { useEffect, useState } from 'react';
import { ErrorBoundary } from './ErrorBoundary.js';
import { InlineEditor } from './editor/InlineEditor.js';
import { vscode } from './vscode.js';

const PRIORITIES = ['critical', 'high', 'medium', 'low'];

/**
 * Split view's right side (spec §5): the card's fields, then its body in the
 * inline editor. Field changes are intents (move / setFields) and never touch
 * the editor's text, which is the body only.
 */
export function DetailPane(props: {
  card: CardView;
  settings: ViewSettings;
  live: boolean;
  onToggleLive: () => void;
  onClose: () => void;
}) {
  const { card, settings } = props;
  const id = card.fields.id!;
  const set = (changes: Record<string, string | string[] | null>) => vscode.postMessage({ type: 'setFields', id, changes });
  useEffect(() => {
    vscode.postMessage({ type: 'editorShown', id });
  }, [id]);

  return (
    <aside className="detail" aria-label={`Card: ${card.title ?? card.filename}`}>
      <header className="detail-header">
        <div className="detail-title">
          <span className="title">{card.title ?? card.filename}</span>
          <span className="filename">{card.path}</span>
        </div>
        <div className="detail-actions">
          <button type="button" className="tool" onClick={props.onToggleLive} title="Switch between live preview and plain markdown">
            {props.live ? 'Source' : 'Preview'}
          </button>
          <button type="button" className="tool" onClick={() => vscode.postMessage({ type: 'openCard', path: card.path })}>
            Open file
          </button>
          <button type="button" className="tool icon" onClick={props.onClose} aria-label="Close (Esc)" title="Close (Esc)">
            ×
          </button>
        </div>
      </header>

      <div className="fields">
        <label>
          <span>Status</span>
          <select
            value={card.fields.status ?? ''}
            onChange={(e) => vscode.postMessage({ type: 'move', id, toStatus: e.target.value, beforeId: null })}
          >
            {settings.columns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Priority</span>
          <select value={card.fields.priority ?? ''} onChange={(e) => set({ priority: e.target.value || null })}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p[0]!.toUpperCase() + p.slice(1)}
              </option>
            ))}
            <option value="">None</option>
          </select>
        </label>
        <label>
          <span>Due</span>
          <input type="date" value={card.fields.dueDate?.slice(0, 10) ?? ''} onChange={(e) => set({ dueDate: e.target.value || null })} />
        </label>
        <TextField label="Assignee" value={card.fields.assignee} onCommit={(v) => set({ assignee: v || null })} />
        <TextField label="Epic" value={card.fields.epic} onCommit={(v) => set({ epic: v || null })} />
        <TextField
          label="Labels"
          wide
          placeholder="comma, separated"
          value={card.fields.labels.join(', ')}
          onCommit={(v) => set({ labels: v.split(',').map((l) => l.trim()).filter(Boolean) })}
        />
      </div>

      <ErrorBoundary>
        <InlineEditor key={id} id={id} live={props.live} onEscape={props.onClose} />
      </ErrorBoundary>
    </aside>
  );
}

/** A text input that commits on Enter or blur, and reverts on Escape. */
function TextField(props: { label: string; value: string | null; onCommit: (v: string) => void; placeholder?: string; wide?: boolean }) {
  const [draft, setDraft] = useState(props.value ?? '');
  useEffect(() => {
    setDraft(props.value ?? '');
  }, [props.value]);
  const commit = () => {
    if (draft.trim() !== (props.value ?? '')) props.onCommit(draft.trim());
  };
  return (
    <label className={props.wide ? 'wide' : undefined}>
      <span>{props.label}</span>
      <input
        value={draft}
        placeholder={props.placeholder ?? '—'}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            e.stopPropagation();
            setDraft(props.value ?? '');
          }
        }}
      />
    </label>
  );
}
