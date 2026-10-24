import { MEMORY_EDITOR_ID, type CardView, type ViewSettings } from '@kanban-bananas/core';
import { useEffect, useState } from 'react';
import { request } from './connection.js';
import { CopyPath } from './CopyPath.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { InlineEditor } from './editor/InlineEditor.js';
import { LabelsField } from './LabelsField.js';
import { EyeOffIcon } from './icons.js';
import { useHub } from './requests.js';
import { hubMode, vscode } from './vscode.js';

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
  /** Wider editor (more room for text, less for the board). */
  wide: boolean;
  /** Absent in pane-only mode: the pane is the whole page, so there is nothing to widen. */
  onToggleWide?: () => void;
  onClose: () => void;
  assetBase: string;
  /** Every label on the board, to suggest while typing. */
  knownLabels: string[];
}) {
  const { card, settings } = props;
  const id = card.fields.id!;
  // Hub mode while the machine is away: the fields and the text show, nothing changes.
  const { readOnly } = useHub();
  const set = (changes: Record<string, string | string[] | null>) => void request({ type: 'setFields', id, changes });
  // A hub's copy without the text (Board 3f): the fields work, the body area is a note; no editor is shown.
  const noText = card.fieldsOnly === true;
  useEffect(() => {
    if (!noText) vscode.postMessage({ type: 'editorShown', id });
  }, [id, noText]);

  return (
    <aside className={`detail ${props.wide ? 'wide' : ''}`} aria-label={`Card: ${card.title ?? card.filename}`}>
      <header className="detail-header">
        <div className="detail-title">
          <span className="title">{card.title ?? card.filename}</span>
          <span className="filename" title={card.path}>
            {card.path}
          </span>
        </div>
        <div className="detail-actions">
          {!hubMode && (
            <button type="button" className="tool" onClick={props.onToggleLive} title="Switch between live preview and plain markdown">
              {props.live ? 'Source' : 'Preview'}
            </button>
          )}
          <CopyPath path={card.path} label="Copy path" />
          {!hubMode && (
            <button type="button" className="tool" onClick={() => vscode.postMessage({ type: 'openCard', path: card.path })}>
              Open file
            </button>
          )}
          {props.onToggleWide && (
            <button
              type="button"
              className="tool icon"
              onClick={props.onToggleWide}
              aria-pressed={props.wide}
              aria-label={props.wide ? 'Narrower editor' : 'Wider editor'}
              title={props.wide ? 'Narrower editor' : 'Wider editor'}
            >
              {props.wide ? '⇥' : '⇤'}
            </button>
          )}
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
            disabled={readOnly}
            onChange={(e) => void request({ type: 'move', id, toStatus: e.target.value, beforeId: null })}
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
          <select value={card.fields.priority ?? ''} disabled={readOnly} onChange={(e) => set({ priority: e.target.value || null })}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p[0]!.toUpperCase() + p.slice(1)}
              </option>
            ))}
            <option value="">None</option>
          </select>
        </label>
        <label>
          <span>Type</span>
          <select
            value={card.fields.type === 'log' ? 'log' : ''}
            disabled={readOnly}
            onChange={(e) => set({ type: e.target.value || null })}
            title="Log: a running list of entries (e.g. minor bugs) instead of a card for each"
          >
            <option value="">Card</option>
            <option value="log">Log</option>
          </select>
        </label>
        <label>
          <span>Due</span>
          <input type="date" value={card.fields.dueDate?.slice(0, 10) ?? ''} disabled={readOnly} onChange={(e) => set({ dueDate: e.target.value || null })} />
        </label>
        <TextField label="Assignee" value={card.fields.assignee} disabled={readOnly} onCommit={(v) => set({ assignee: v || null })} />
        <TextField label="Epic" value={card.fields.epic} disabled={readOnly} onCommit={(v) => set({ epic: v || null })} />
        {((settings.lanes?.lane.length ?? 0) > 0 || card.fields.lane) && (
          <TextField label="Lane" value={card.fields.lane} disabled={readOnly} onCommit={(v) => set({ lane: v || null })} />
        )}
        <LabelsField key={id} labels={card.fields.labels} known={props.knownLabels} disabled={readOnly} onChange={(labels) => set({ labels })} />
      </div>

      {noText ? (
        <div className="text-not-shared-note" role="note">
          <EyeOffIcon size={16} />
          <div>
            <strong>The text stays in the repo</strong>
            <div>This repo shares titles and fields only. Open the card in VS Code to read or edit its text.</div>
          </div>
        </div>
      ) : (
        <ErrorBoundary>
          <InlineEditor
            key={id}
            id={id}
            live={props.live}
            onEscape={props.onClose}
            images={settings.images ?? { format: 'webp', maxWidth: 0 }}
            assetBase={props.assetBase}
            log={card.fields.type === 'log'}
            readOnly={readOnly}
            {...(settings.columns[0] ? { newCardStatus: settings.columns[0].id } : {})}
          />
        </ErrorBoundary>
      )}
    </aside>
  );
}

/** The session memory in the split view: the whole file, in the same editor as cards. */
export function MemoryPane(props: {
  file: string;
  settings: ViewSettings;
  live: boolean;
  onToggleLive: () => void;
  wide: boolean;
  onToggleWide: () => void;
  onClose: () => void;
  assetBase: string;
}) {
  useEffect(() => {
    vscode.postMessage({ type: 'editorShown', id: MEMORY_EDITOR_ID });
  }, []);
  return (
    <aside className={`detail memory-detail ${props.wide ? 'wide' : ''}`} aria-label="Session memory">
      <header className="detail-header">
        <div className="detail-title">
          <span className="title">Session memory</span>
          <span className="filename">{props.file}</span>
        </div>
        <div className="detail-actions">
          {!hubMode && (
            <button type="button" className="tool" onClick={props.onToggleLive} title="Switch between live preview and plain markdown">
              {props.live ? 'Source' : 'Preview'}
            </button>
          )}
          {!hubMode && (
            <button type="button" className="tool" onClick={() => vscode.postMessage({ type: 'openMemory' })}>
              Open file
            </button>
          )}
          <button
            type="button"
            className="tool icon"
            onClick={props.onToggleWide}
            aria-pressed={props.wide}
            aria-label={props.wide ? 'Narrower editor' : 'Wider editor'}
            title={props.wide ? 'Narrower editor' : 'Wider editor'}
          >
            {props.wide ? '⇥' : '⇤'}
          </button>
          <button type="button" className="tool icon" onClick={props.onClose} aria-label="Close (Esc)" title="Close (Esc)">
            ×
          </button>
        </div>
      </header>
      <p className="memory-hint">Where the work stands, for the next session. Agents update it; you can edit it here too.</p>
      <ErrorBoundary>
        <InlineEditor
          key={MEMORY_EDITOR_ID}
          id={MEMORY_EDITOR_ID}
          live={props.live}
          onEscape={props.onClose}
          images={props.settings.images ?? { format: 'webp', maxWidth: 0 }}
          assetBase={props.assetBase}
        />
      </ErrorBoundary>
    </aside>
  );
}

/** A text input that commits on Enter or blur, and reverts on Escape. */
function TextField(props: { label: string; value: string | null; onCommit: (v: string) => void; placeholder?: string; wide?: boolean; disabled?: boolean }) {
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
        disabled={props.disabled}
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
