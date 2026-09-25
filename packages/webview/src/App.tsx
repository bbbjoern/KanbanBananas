import type { BoardView, BrokenView, CardView, ColumnConfig, ViewSettings } from '@kanban-bananas/core';
import { useEffect, useMemo, useState } from 'react';
import { formatDue } from './dates.js';
import { onHostMessage, vscode } from './vscode.js';

export type Layout = 'panel' | 'sidebar';

const MAX_LABELS = 3;

interface UiState {
  collapsed: string[];
}

export function App({ layout }: { layout: Layout }) {
  const [board, setBoard] = useState<BoardView | null>(null);
  const [settings, setSettings] = useState<ViewSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<string[]>(
    () => (vscode.getState() as UiState | undefined)?.collapsed ?? [],
  );

  useEffect(() => {
    const off = onHostMessage((m) => {
      if (m.type === 'state') {
        setBoard(m.board);
        setSettings(m.settings);
        setError(null);
      } else {
        setError(m.message);
      }
    });
    vscode.postMessage({ type: 'ready' });
    return off;
  }, []);

  const toggle = (id: string) => {
    const next = collapsed.includes(id) ? collapsed.filter((c) => c !== id) : [...collapsed, id];
    setCollapsed(next);
    vscode.setState({ collapsed: next } satisfies UiState);
  };

  const byStatus = useMemo(() => {
    const map = new Map<string, CardView[]>();
    for (const card of board?.cards ?? []) {
      const status = card.fields.status ?? '';
      map.set(status, [...(map.get(status) ?? []), card]);
    }
    return map;
  }, [board]);

  if (error) return <div className="message error">{error}</div>;
  if (!board || !settings) return <div className="message">Loading board…</div>;

  return (
    <div className={`board ${layout} ${settings.compactMode ? 'compact' : ''}`}>
      {board.broken.length > 0 && (
        <BrokenLane broken={board.broken} collapsed={collapsed.includes('#broken')} onToggle={() => toggle('#broken')} />
      )}
      {settings.columns.map((col) => (
        <Column
          key={col.id}
          column={col}
          cards={byStatus.get(col.id) ?? []}
          settings={settings}
          collapsed={collapsed.includes(col.id)}
          onToggle={() => toggle(col.id)}
        />
      ))}
    </div>
  );
}

function Column(props: {
  column: ColumnConfig;
  cards: CardView[];
  settings: ViewSettings;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { column, cards, collapsed } = props;
  return (
    <section className={`column ${collapsed ? 'collapsed' : ''}`} style={{ '--column-color': column.color } as React.CSSProperties}>
      <ColumnHeader name={column.name} count={cards.length} collapsed={collapsed} onToggle={props.onToggle} />
      {!collapsed && (
        <div className="cards">
          {cards.map((card) => (
            <Card key={card.path} card={card} settings={props.settings} />
          ))}
        </div>
      )}
    </section>
  );
}

function ColumnHeader(props: { name: string; count: number; collapsed: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="column-header" onClick={props.onToggle} aria-expanded={!props.collapsed}>
      <span className="chevron" aria-hidden>
        {props.collapsed ? '▸' : '▾'}
      </span>
      <span className="dot" aria-hidden />
      <span className="name">{props.name}</span>
      <span className="count">{props.count}</span>
    </button>
  );
}

function Card({ card, settings }: { card: CardView; settings: ViewSettings }) {
  const { fields } = card;
  const show = settings.show;
  const due = show.dueDate && fields.dueDate ? formatDue(fields.dueDate, new Date()) : null;
  const labels = show.labels ? fields.labels : [];
  const hasMeta = labels.length > 0 || due || (show.assignee && fields.assignee) || (show.epic && fields.epic);

  return (
    <button
      type="button"
      className="card"
      title={card.path}
      onClick={() => vscode.postMessage({ type: 'openCard', path: card.path })}
    >
      <div className="card-top">
        {show.priority && fields.priority && (
          <span className={`priority priority-${fields.priority}`}>{fields.priority}</span>
        )}
        {card.warnings.length > 0 && (
          <span className="warning" title={card.warnings.join('\n')}>
            ⚠
          </span>
        )}
      </div>
      <div className="title">{card.title ?? card.filename}</div>
      {!settings.compactMode && card.excerpt && <div className="excerpt">{card.excerpt}</div>}
      {hasMeta && (
        <div className="meta">
          {labels.slice(0, MAX_LABELS).map((l) => (
            <span key={l} className="label">
              {l}
            </span>
          ))}
          {labels.length > MAX_LABELS && <span className="label more">+{labels.length - MAX_LABELS} more</span>}
          {due && <span className={`due due-${due.tone}`}>{due.text}</span>}
          {show.epic && fields.epic && <span className="epic">{fields.epic}</span>}
          {show.assignee && fields.assignee && <span className="assignee">@{fields.assignee}</span>}
        </div>
      )}
      {show.filename && <div className="filename">{card.filename}</div>}
    </button>
  );
}

function BrokenLane(props: { broken: BrokenView[]; collapsed: boolean; onToggle: () => void }) {
  return (
    <section className={`column broken ${props.collapsed ? 'collapsed' : ''}`}>
      <ColumnHeader name="Broken" count={props.broken.length} collapsed={props.collapsed} onToggle={props.onToggle} />
      {!props.collapsed && (
        <div className="cards">
          <p className="broken-note">These files can't be shown as cards. The board never writes to them.</p>
          {props.broken.map((b) => (
            <button
              key={b.path}
              type="button"
              className="card"
              title={b.path}
              onClick={() => vscode.postMessage({ type: 'openCard', path: b.path })}
            >
              <div className="title">{b.title ?? b.filename}</div>
              <div className="filename">{b.path}</div>
              <ul className="problems">
                {b.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
