import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { BoardView, BrokenView, CardView, ColumnConfig, ViewSettings } from '@kanban-bananas/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { findColumn, moveCard, moveIntent, type Columns } from './columns.js';
import { formatDue } from './dates.js';
import { onHostMessage, vscode } from './vscode.js';

export type Layout = 'panel' | 'sidebar';

const MAX_LABELS = 3;
const COLUMN_PREFIX = 'column:';

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
  /** Column being given a new card, if any. */
  const [adding, setAdding] = useState<string | null>(null);

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

  // N: new card in the first column (when not typing somewhere).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'n' && e.key !== 'N') return;
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const first = settings?.columns[0]?.id;
      if (first) {
        e.preventDefault();
        setAdding(first);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [settings]);

  const toggle = (id: string) => {
    const next = collapsed.includes(id) ? collapsed.filter((c) => c !== id) : [...collapsed, id];
    setCollapsed(next);
    vscode.setState({ collapsed: next } satisfies UiState);
  };

  const cardsById = useMemo(() => new Map((board?.cards ?? []).map((c) => [c.fields.id!, c])), [board]);
  const hostColumns = useMemo(() => {
    const cols: Columns = {};
    for (const col of settings?.columns ?? []) cols[col.id] = [];
    for (const card of board?.cards ?? []) cols[card.fields.status!]?.push(card.fields.id!);
    return cols;
  }, [board, settings]);

  // Working copy while dragging; replaced whenever the host sends a new board.
  const [columns, setColumns] = useState<Columns>(hostColumns);
  useEffect(() => setColumns(hostColumns), [hostColumns]);
  const dragStart = useRef<Columns | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    // A small distance, so a click still opens the card.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const columnOf = (id: string) =>
    id.startsWith(COLUMN_PREFIX) ? id.slice(COLUMN_PREFIX.length) : findColumn(columns, id);

  const onDragStart = (e: DragStartEvent) => {
    dragStart.current = columns;
    setActiveId(String(e.active.id));
  };

  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over) return;
    const id = String(active.id);
    const to = columnOf(String(over.id));
    const from = findColumn(columns, id);
    if (!to || !from || to === from) return;
    // Crossing into another column: insert at the hovered card, or at the end.
    const overIndex = columns[to]!.indexOf(String(over.id));
    setColumns(moveCard(columns, id, to, overIndex === -1 ? columns[to]!.length : overIndex));
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setActiveId(null);
    const before = dragStart.current;
    dragStart.current = null;
    if (!before || !over) {
      setColumns(hostColumns);
      return;
    }
    const id = String(active.id);
    const to = columnOf(String(over.id));
    if (!to) return;
    let after = columns;
    const overIndex = columns[to]!.indexOf(String(over.id));
    if (overIndex !== -1 && String(over.id) !== id) after = moveCard(columns, id, to, overIndex);
    setColumns(after);
    const intent = moveIntent(before, after, id);
    if (intent) vscode.postMessage({ type: 'move', id, ...intent });
  };

  if (error) return <div className="message error">{error}</div>;
  if (!board || !settings) return <div className="message">Loading board…</div>;

  const active = activeId ? cardsById.get(activeId) : undefined;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        setActiveId(null);
        setColumns(hostColumns);
      }}
    >
      <div className={`board ${layout} ${settings.compactMode ? 'compact' : ''}`}>
        {board.broken.length > 0 && (
          <BrokenLane broken={board.broken} collapsed={collapsed.includes('#broken')} onToggle={() => toggle('#broken')} />
        )}
        {settings.columns.map((col) => (
          <Column
            key={col.id}
            column={col}
            cards={(columns[col.id] ?? []).map((id) => cardsById.get(id)).filter((c): c is CardView => !!c)}
            settings={settings}
            collapsed={collapsed.includes(col.id)}
            onToggle={() => toggle(col.id)}
            adding={adding === col.id}
            onAdd={() => setAdding(col.id)}
            onAddDone={() => setAdding(null)}
          />
        ))}
      </div>
      <DragOverlay>{active && <CardBody card={active} settings={settings} dragging />}</DragOverlay>
    </DndContext>
  );
}

function Column(props: {
  column: ColumnConfig;
  cards: CardView[];
  settings: ViewSettings;
  collapsed: boolean;
  onToggle: () => void;
  adding: boolean;
  onAdd: () => void;
  onAddDone: () => void;
}) {
  const { column, cards, collapsed, settings } = props;
  const { setNodeRef } = useDroppable({ id: COLUMN_PREFIX + column.id });
  const form = props.adding && <NewCardForm status={column.id} onDone={props.onAddDone} />;
  return (
    <section className={`column ${collapsed ? 'collapsed' : ''}`} style={{ '--column-color': column.color } as React.CSSProperties}>
      <ColumnHeader
        name={column.name}
        count={cards.length}
        collapsed={collapsed}
        onToggle={props.onToggle}
        onAdd={props.onAdd}
      />
      {!collapsed && (
        <SortableContext items={cards.map((c) => c.fields.id!)} strategy={verticalListSortingStrategy}>
          <div className="cards" ref={setNodeRef}>
            {settings.addNewCardsToTop && form}
            {cards.map((card) => (
              <SortableCard key={card.fields.id} card={card} settings={settings} />
            ))}
            {!settings.addNewCardsToTop && form}
          </div>
        </SortableContext>
      )}
    </section>
  );
}

function ColumnHeader(props: {
  name: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  onAdd?: () => void;
}) {
  return (
    <div className="column-header">
      <button type="button" className="column-toggle" onClick={props.onToggle} aria-expanded={!props.collapsed}>
        <span className="chevron" aria-hidden>
          {props.collapsed ? '▸' : '▾'}
        </span>
        <span className="dot" aria-hidden />
        <span className="name">{props.name}</span>
        <span className="count">{props.count}</span>
      </button>
      {props.onAdd && (
        <button type="button" className="add" onClick={props.onAdd} title="New card (N)" aria-label={`New card in ${props.name}`}>
          +
        </button>
      )}
    </div>
  );
}

function NewCardForm({ status, onDone }: { status: string; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const submit = () => {
    if (title.trim()) vscode.postMessage({ type: 'create', title: title.trim(), status });
    onDone();
  };
  return (
    <textarea
      className="new-card"
      autoFocus
      rows={2}
      placeholder="Card title. Enter to add, Esc to cancel."
      value={title}
      onChange={(e) => setTitle(e.target.value)}
      onBlur={() => (title.trim() ? submit() : onDone())}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onDone();
        } else if (e.key === 'Enter' && !e.shiftKey) {
          // Enter and Cmd/Ctrl+Enter both submit.
          e.preventDefault();
          submit();
        }
      }}
    />
  );
}

function SortableCard({ card, settings }: { card: CardView; settings: ViewSettings }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: card.fields.id! });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? 'drag-source' : undefined}
      {...attributes}
      {...listeners}
    >
      <CardBody card={card} settings={settings} />
    </div>
  );
}

function CardBody({ card, settings, dragging }: { card: CardView; settings: ViewSettings; dragging?: boolean }) {
  const { fields } = card;
  const show = settings.show;
  const due = show.dueDate && fields.dueDate ? formatDue(fields.dueDate, new Date()) : null;
  const labels = show.labels ? fields.labels : [];
  const priority = show.priority ? fields.priority : null;
  const hasMeta =
    priority || labels.length > 0 || due || (show.assignee && fields.assignee) || (show.epic && fields.epic);

  return (
    <button
      type="button"
      className={`card ${dragging ? 'dragging' : ''}`}
      title={card.path}
      // Right-click menu: VS Code reads this and shows the kanbanBananas.card.* commands.
      data-vscode-context={JSON.stringify({ webviewSection: 'card', cardId: fields.id, preventDefaultContextMenuItems: true })}
      onClick={() => vscode.postMessage({ type: 'openCard', path: card.path })}
    >
      <div className="title-row">
        <span className="title">{card.title ?? card.filename}</span>
        {card.warnings.length > 0 && (
          <span className="warning" title={card.warnings.join('\n')} aria-label="Warning">
            !
          </span>
        )}
      </div>
      {!settings.compactMode && card.excerpt && <div className="excerpt">{card.excerpt}</div>}
      {hasMeta && (
        <div className="meta">
          {priority && (
            <span className={`priority priority-${priority}`}>
              <span className="pdot" aria-hidden />
              {priority}
            </span>
          )}
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

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}
