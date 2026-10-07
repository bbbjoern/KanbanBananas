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
import { MEMORY_EDITOR_ID, type BoardView, type BrokenView, type CardView, type ColumnConfig, type GroupField, type ViewSettings } from '@kanban-bananas/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { findColumn, moveCard, moveIntent, type Columns } from './columns.js';
import { CopyPath } from './CopyPath.js';
import { checkConnection, onReconnect, request, useConnected } from './connection.js';
import { DetailPane, MemoryPane } from './DetailPane.js';
import { PendingCardList, usePendingCards } from './pendingCards.js';
import { MemoryWidget, type MemorySummary } from './MemoryWidget.js';
import { formatDue } from './dates.js';
import { distinct, filtersActive, laneColor, laneValues, NO_FILTERS, NONE_LANE_NAME, passes, reorderLanes, type Filters } from './filters.js';
import { Toolbar } from './Toolbar.js';
import { onHostMessage, vscode } from './vscode.js';

export type Layout = 'panel' | 'sidebar';

const MAX_LABELS = 3;
const COLUMN_PREFIX = 'column:';
const SEARCH_DELAY_MS = 150;
/** Separates lane and status in a cell key when cards are grouped into lanes. */
const CELL_SEP = '\u0001';
const NO_VALUE = '';

/** A drop target: a column (`status`), or one lane's part of a column (`value␁status`). */
function cellKey(grouped: boolean, value: string | null, status: string): string {
  return grouped ? `${value ?? NO_VALUE}${CELL_SEP}${status}` : status;
}

function parseCell(key: string): { value: string | null; status: string } {
  const i = key.indexOf(CELL_SEP);
  if (i === -1) return { value: null, status: key };
  const value = key.slice(0, i);
  return { value: value === NO_VALUE ? null : value, status: key.slice(i + 1) };
}

export type GroupBy = GroupField | 'none';

interface UiState {
  collapsed: string[];
  /** Inline editor in live preview (true) or plain markdown. */
  live?: boolean;
  /** Card open in the split view. */
  selected?: string | null;
  filters?: Filters;
  /** Group the board into lanes by a field. */
  groupBy?: GroupBy;
  /** Split view editor widened. */
  wide?: boolean;
  /** Before 0.5: epic lanes on/off. */
  lanes?: boolean;
}

export function App({ layout }: { layout: Layout }) {
  const [board, setBoard] = useState<BoardView | null>(null);
  const [settings, setSettings] = useState<ViewSettings | null>(null);
  const [assetBase, setAssetBase] = useState('');
  const [memory, setMemory] = useState<MemorySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noBoard, setNoBoard] = useState<{ featuresDirectory: string; folderOpen: boolean } | null>(null);
  // The page's own state survives hiding; the host's copy survives closing the board and reloading.
  const saved = (vscode.getState() ?? (window as { __KANBAN_UI_STATE__?: unknown }).__KANBAN_UI_STATE__ ?? undefined) as UiState | undefined;
  const [collapsed, setCollapsed] = useState<string[]>(saved?.collapsed ?? []);
  const [live, setLive] = useState(saved?.live ?? true);
  const [selected, setSelected] = useState<string | null>(saved?.selected ?? null);
  const [filters, setFilters] = useState<Filters>({ ...NO_FILTERS, ...saved?.filters });
  const [groupBy, setGroupBy] = useState<GroupBy>(saved?.groupBy ?? (saved?.lanes ? 'epic' : 'none'));
  const [wide, setWide] = useState(saved?.wide ?? false);
  const grouping: GroupField | null = layout === 'panel' && groupBy !== 'none' ? groupBy : null;
  const lanes = grouping !== null;
  useEffect(() => {
    const state = { collapsed, live, selected, filters, groupBy, wide } satisfies UiState;
    vscode.setState(state);
    const t = setTimeout(() => vscode.postMessage({ type: 'uiState', state }), 300);
    return () => clearTimeout(t);
  }, [collapsed, live, selected, filters, groupBy, wide]);

  // Full-text search runs in the host, which has the card bodies.
  const [searchIds, setSearchIds] = useState<Set<string> | null>(null);
  const query = filters.query.trim();
  /** Column being given a new card, if any. */
  const [adding, setAdding] = useState<string | null>(null);

  useEffect(() => {
    const off = onHostMessage((m) => {
      if (m.type === 'state') {
        setBoard(m.board);
        setSettings(m.settings);
        setNoBoard(null);
        setAssetBase(m.assetBase ?? '');
        setMemory(m.memory ?? null);
        setError(null);
      } else if (m.type === 'error') {
        setError(m.message);
      } else if (m.type === 'noBoard') {
        setNoBoard({ featuresDirectory: m.featuresDirectory, folderOpen: m.folderOpen });
        setBoard(null);
      } else if (m.type === 'selectCard') {
        setSelected(m.id);
      } else if (m.type === 'searchResults') {
        if (m.query === queryRef.current) setSearchIds(new Set(m.ids));
      }
      // Editor messages are handled by the inline editor itself.
    });
    vscode.postMessage({ type: 'ready', build: __BOARD_BUILD__ });
    return off;
  }, []);

  const connected = useConnected();
  // Back after a lost connection: ask for the current board, since changes may have happened meanwhile.
  useEffect(() => onReconnect(() => vscode.postMessage({ type: 'ready' })), []);

  const queryRef = useRef(query);
  queryRef.current = query;
  useEffect(() => {
    if (!query) {
      setSearchIds(null);
      return;
    }
    // Re-run when the board changes too, so results follow edits.
    const t = setTimeout(() => vscode.postMessage({ type: 'search', query }), SEARCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [query, board]);

  // N: new card in the first column (when not typing somewhere).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'n' && e.key !== 'N') return;
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const status = settings?.defaultStatus || settings?.columns[0]?.id;
      if (status) {
        e.preventDefault();
        setAdding(status);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [settings]);

  const toggle = (id: string) => {
    setCollapsed(collapsed.includes(id) ? collapsed.filter((c) => c !== id) : [...collapsed, id]);
  };

  const cardsById = useMemo(() => new Map((board?.cards ?? []).map((c) => [c.fields.id!, c])), [board]);
  const visible = useMemo(() => {
    const now = new Date();
    return (board?.cards ?? []).filter((c) => passes(c, filters, now, query ? searchIds : null));
  }, [board, filters, searchIds, query]);
  /** Lanes of the current grouping: configured ones, then values used on cards, then "none". */
  const laneList = useMemo(
    () => (grouping && settings ? laneValues(board?.cards ?? [], grouping, settings.lanes?.[grouping] ?? []) : []),
    [board, settings, grouping],
  );
  const hostColumns = useMemo(() => {
    const cols: Columns = {};
    for (const col of settings?.columns ?? []) {
      if (lanes) for (const value of laneList) cols[cellKey(true, value, col.id)] = [];
      else cols[col.id] = [];
    }
    for (const card of visible) {
      cols[cellKey(lanes, grouping ? card.fields[grouping] : null, card.fields.status!)]?.push(card.fields.id!);
    }
    return cols;
  }, [visible, settings, lanes, laneList, grouping]);
  const totals = useMemo(() => {
    const t = new Map<string, number>();
    for (const c of board?.cards ?? []) t.set(c.fields.status!, (t.get(c.fields.status!) ?? 0) + 1);
    return t;
  }, [board]);

  const hostColumnsRef = useRef(hostColumns);
  hostColumnsRef.current = hostColumns;
  // Working copy while dragging; replaced whenever the host sends a new board.
  const [columns, setColumns] = useState<Columns>(hostColumns);
  useEffect(() => {
    setColumns(hostColumns);
  }, [hostColumns]);
  const dragStart = useRef<Columns | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    // A small distance, so a click still opens the card.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const columnDrag = useColumnDrag((settings?.columns ?? []).map((c) => c.id));

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
    if (!intent) return;
    const target = parseCell(intent.toStatus);
    const card = cardsById.get(id);
    void request({ type: 'move', id, toStatus: target.status, beforeId: intent.beforeId }).then((r) => {
      // Not confirmed: show the board as the files are, not as the drop suggested.
      if (!r.ok) setColumns(hostColumnsRef.current);
    });
    // Dropped into another lane: the card takes that lane's value too.
    if (grouping && card && target.value !== card.fields[grouping]) {
      void request({ type: 'setFields', id, changes: { [grouping]: target.value } });
    }
  };

  if (noBoard) return <Welcome {...noBoard} layout={layout} />;
  if (error) return <div className="message error">{error}</div>;
  if (!board || !settings) return <div className="message">Loading board…</div>;

  const active = activeId ? cardsById.get(activeId) : undefined;
  const selectedCard = layout === 'panel' && selected ? cardsById.get(selected) : undefined;
  const memoryOpen = layout === 'panel' && selected === MEMORY_EDITOR_ID && memory !== null;
  // The session memory opens in the split view like a card; the sidebar has none, so there it opens the file.
  const openMemory = () => (layout === 'panel' ? setSelected(MEMORY_EDITOR_ID) : vscode.postMessage({ type: 'openMemory' }));
  // Panel: a click opens the split view. Sidebar (narrow): a click opens the file in VS Code's editor.
  const onOpen = (card: CardView) =>
    layout === 'panel' ? setSelected(card.fields.id!) : vscode.postMessage({ type: 'openCard', path: card.path });

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
      <div className={`workspace ${selectedCard || memoryOpen ? 'split' : ''} ${settings.hideScrollbars ? 'no-scrollbars' : ''}`}>
      <div className="board-area">
      {!connected && (
        <div className="offline" role="alert">
          <p>
            <strong>Not connected to KanbanBananas.</strong> Changes made now aren't saved. This usually happens after
            the computer slept or the remote connection dropped; it reconnects by itself when it can.
            If it doesn't, run <em>Developer: Reload Window</em>.
          </p>
          <button type="button" className="tool" onClick={checkConnection}>
            Check again
          </button>
        </div>
      )}
      <Toolbar
        layout={layout}
        cards={board.cards}
        filters={filters}
        onFilters={setFilters}
        groupBy={groupBy}
        onGroupBy={setGroupBy}
        shown={visible.length}
      />
      {lanes ? (
        <LaneBoard
          memory={memory}
          onOpenMemory={openMemory}
          drag={columnDrag}
          field={grouping!}
          settings={settings}
          lanes={laneList}
          columns={columns}
          cardsById={cardsById}
          totals={totals}
          filtering={filtersActive(filters)}
          collapsed={collapsed}
          onToggle={toggle}
          adding={adding}
          onAdd={setAdding}
          selected={selectedCard?.fields.id ?? null}
          onOpen={onOpen}
          broken={board.broken}
        />
      ) : (
      <div className={`board ${layout} ${layout === 'panel' ? settings.layout : ''} ${settings.compactMode ? 'compact' : ''}`}>
        {board.broken.length > 0 && (
          <BrokenLane broken={board.broken} collapsed={collapsed.includes('#broken')} onToggle={() => toggle('#broken')} />
        )}
        {layout === 'sidebar' && memory && <MemoryWidget memory={memory} onOpen={openMemory} />}
        {settings.columns.map((col, i) => (
          <Column
            key={col.id}
            top={i === 0 && layout === 'panel' && memory ? <MemoryWidget memory={memory} onOpen={openMemory} /> : null}
            drag={columnDrag}
            column={col}
            cards={(columns[col.id] ?? []).map((id) => cardsById.get(id)).filter((c): c is CardView => !!c)}
            total={filtersActive(filters) ? totals.get(col.id) ?? 0 : null}
            settings={settings}
            collapsed={collapsed.includes(col.id)}
            onToggle={() => toggle(col.id)}
            adding={adding === col.id}
            onAdd={() => setAdding(col.id)}
            onAddDone={() => setAdding(null)}
            selected={selectedCard?.fields.id ?? null}
            onOpen={onOpen}
          />
        ))}
        {layout === 'panel' && <AddColumn />}
      </div>
      )}
      </div>
      {memoryOpen && (
        <MemoryPane
          file={memory!.file}
          settings={settings}
          live={live}
          onToggleLive={() => setLive(!live)}
          wide={wide}
          onToggleWide={() => setWide(!wide)}
          onClose={() => setSelected(null)}
          assetBase={assetBase}
        />
      )}
      {selectedCard && (
        <DetailPane
          card={selectedCard}
          settings={settings}
          live={live}
          onToggleLive={() => setLive(!live)}
          wide={wide}
          onToggleWide={() => setWide(!wide)}
          assetBase={assetBase}
          knownLabels={distinct(board.cards, (c) => c.fields.labels)}
          onClose={() => setSelected(null)}
        />
      )}
      </div>
      <DragOverlay>{active && <CardBody card={active} settings={settings} dragging onOpen={() => {}} />}</DragOverlay>
    </DndContext>
  );
}

/**
 * Cards grouped into lanes by a field (spec §5): column headers once at the
 * top, then a row of cells per lane. Lanes collapse, have colours, and a
 * right-click menu to rename or delete them; "New lane" adds one.
 */
function LaneBoard(props: {
  memory: MemorySummary | null;
  onOpenMemory: () => void;
  drag: ColumnDrag;
  field: GroupField;
  settings: ViewSettings;
  lanes: (string | null)[];
  columns: Columns;
  cardsById: Map<string, CardView>;
  totals: Map<string, number>;
  filtering: boolean;
  collapsed: string[];
  onToggle: (key: string) => void;
  adding: string | null;
  onAdd: (status: string | null) => void;
  selected: string | null;
  onOpen: (card: CardView) => void;
  broken: BrokenView[];
}) {
  const { settings, columns, field } = props;
  const configured = settings.lanes?.[field] ?? [];
  // Lane reordering uses the browser's own drag and drop on the lane handle, separate from card dragging.
  // `undefined` = not dragging; null = dragging the "none" lane.
  const [dragLane, setDragLane] = useState<string | null | undefined>(undefined);
  const named = props.lanes.filter((v): v is string => v !== null);
  const dropLane = (dragged: string | null, target: string | null) => {
    setDragLane(undefined);
    if (dragged === target) return;
    vscode.postMessage({ type: 'laneOrder', field, order: reorderLanes(props.lanes, dragged, target) });
  };
  const cellCards = (value: string | null, status: string) =>
    (columns[cellKey(true, value, status)] ?? []).map((id) => props.cardsById.get(id)).filter((c): c is CardView => !!c);
  const shownIn = (status: string) => props.lanes.reduce((n, value) => n + cellCards(value, status).length, 0);

  return (
    <div className={`board lanes ${settings.compactMode ? 'compact' : ''}`}>
      {props.broken.length > 0 && (
        <div className="lane-broken">
          <BrokenLane broken={props.broken} collapsed={props.collapsed.includes('#broken')} onToggle={() => props.onToggle('#broken')} />
        </div>
      )}
      <div className="lane-header-row">
        {settings.columns.map((col, i) => {
          const collapsed = props.collapsed.includes(col.id);
          return (
            <section
              key={col.id}
              className={`column lane-column-head ${collapsed ? 'collapsed' : ''}`}
              style={{ '--column-color': col.color } as React.CSSProperties}
            >
              {i === 0 && props.memory && <MemoryWidget memory={props.memory} onOpen={props.onOpenMemory} />}
              <ColumnHeader
                name={col.name}
                status={col.id}
                drag={props.drag}
                count={shownIn(col.id)}
                total={props.filtering ? props.totals.get(col.id) ?? 0 : null}
                collapsed={collapsed}
                onToggle={() => props.onToggle(col.id)}
                {...(collapsed ? {} : { onAdd: () => props.onAdd(col.id) })}
              />
              {props.adding === col.id && (
                <div className="cards">
                  <NewCardForm status={col.id} onDone={() => props.onAdd(null)} />
                </div>
              )}
              <PendingCardList status={col.id} wrapped />
            </section>
          );
        })}
      </div>
      <div className="lane-bar">
        <button type="button" className="tool new-lane" onClick={() => vscode.postMessage({ type: 'laneCommand', action: 'new', field })}>
          + New swimlane
        </button>
        {named.length === 0 && (
          <span className="lane-hint">
            No {field === 'assignee' ? 'assignees' : `${field === 'priority' ? 'priorities' : `${field}s`}`} yet: add a swimlane, then drag cards into it.
          </span>
        )}
      </div>
      {props.lanes.map((value) => {
        const key = `#lane:${field}:${value ?? NO_VALUE}`;
        const collapsed = props.collapsed.includes(key);
        const count = settings.columns.reduce((n, col) => n + cellCards(value, col.id).length, 0);
        const color = value ? laneColor(field, value, configured, settings.epicColors) : 'var(--muted)';
        return (
          <div key={key} className={`lane ${collapsed ? 'collapsed' : ''}`} style={{ '--lane-color': color } as React.CSSProperties}>
            <LaneHeader
              field={field}
              value={value}
              count={count}
              collapsed={collapsed}
              onToggle={() => props.onToggle(key)}
              dragging={dragLane}
              onDragLane={setDragLane}
              onDropLane={(dragged) => dropLane(dragged, value)}
              order={props.lanes}
            />
            {!collapsed && (
              <div className="lane-row">
                {settings.columns.map((col) => (
                  <LaneCell
                    key={col.id}
                    cell={cellKey(true, value, col.id)}
                    color={col.color}
                    collapsed={props.collapsed.includes(col.id)}
                    cards={cellCards(value, col.id)}
                    settings={settings}
                    selected={props.selected}
                    onOpen={props.onOpen}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A lane's header: drag handle (reorder), chevron (collapse), name (click to
 * rename, except "none"), count. Only the chevron collapses the lane.
 */
function LaneHeader(props: {
  field: GroupField;
  value: string | null;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  /** The lane being dragged: undefined when none is; null is the "none" lane. */
  dragging: string | null | undefined;
  onDragLane: (value: string | null | undefined) => void;
  onDropLane: (dragged: string | null) => void;
  /** Current lane order (null = "none"), for the Move Up/Down menu items. */
  order: (string | null)[];
}) {
  const { field, value } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [over, setOver] = useState(false);
  const label = value === null ? NONE_LANE_NAME[field] : field === 'priority' ? value[0]!.toUpperCase() + value.slice(1) : value;
  const commit = () => {
    setEditing(false);
    const to = draft.trim();
    if (value !== null && to && to !== value) vscode.postMessage({ type: 'laneCommand', action: 'rename', field, value, to });
  };

  return (
    <div
      className={`lane-header ${over && props.dragging !== undefined && props.dragging !== value ? 'drop-target' : ''}`}
      data-vscode-context={JSON.stringify({ webviewSection: value ? 'lane' : 'laneNone', field, value, order: props.order, preventDefaultContextMenuItems: true })}
      title={value === null ? `Cards without ${field === 'assignee' ? 'an assignee' : `a ${field}`}. Drag to move this lane; it can't be renamed.` : undefined}
      onDragOver={(e) => {
        if (props.dragging === undefined) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (props.dragging !== undefined) props.onDropLane(props.dragging);
      }}
    >
      <span
        className="lane-grip"
        draggable
        title="Drag to reorder lanes"
        aria-label={`Reorder lane ${label}`}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', value ?? '');
          props.onDragLane(value);
        }}
        onDragEnd={() => props.onDragLane(undefined)}
      >
        ⋮⋮
      </span>
      <Chevron collapsed={props.collapsed} onToggle={props.onToggle} label={`lane ${label}`} />
      <span className="lane-swatch" aria-hidden />
      {editing ? (
        <input
          className="lane-name-input"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              e.stopPropagation();
              setDraft(value ?? '');
              setEditing(false);
            }
          }}
          aria-label={`New name for lane ${label}`}
        />
      ) : value !== null ? (
        <button
          type="button"
          className="name lane-name"
          title="Click to rename"
          onClick={() => {
            setDraft(value);
            setEditing(true);
          }}
        >
          {label}
        </button>
      ) : (
        <span className="name">{label}</span>
      )}
      <span className="count">{props.count}</span>
    </div>
  );
}

function LaneCell(props: {
  cell: string;
  color: string;
  collapsed: boolean;
  cards: CardView[];
  settings: ViewSettings;
  selected: string | null;
  onOpen: (card: CardView) => void;
}) {
  const { setNodeRef } = useDroppable({ id: COLUMN_PREFIX + props.cell });
  return (
    <div className={`lane-cell ${props.collapsed ? 'collapsed' : ''}`} style={{ '--column-color': props.color } as React.CSSProperties}>
      {props.collapsed ? (
        <span className="lane-cell-count">{props.cards.length || ''}</span>
      ) : (
        <SortableContext items={props.cards.map((c) => c.fields.id!)} strategy={verticalListSortingStrategy}>
          <div className="cards" ref={setNodeRef}>
            {props.cards.map((card) => (
              <SortableCard
                key={card.fields.id}
                card={card}
                settings={props.settings}
                selected={card.fields.id === props.selected}
                onOpen={props.onOpen}
              />
            ))}
          </div>
        </SortableContext>
      )}
    </div>
  );
}

function Column(props: {
  column: ColumnConfig;
  cards: CardView[];
  /** All cards in the column, when a filter hides some; shown as "shown / total". */
  total: number | null;
  /** Shown above the header (the session memory, in the first column). */
  top?: React.ReactNode;
  drag: ColumnDrag;
  settings: ViewSettings;
  collapsed: boolean;
  onToggle: () => void;
  adding: boolean;
  onAdd: () => void;
  onAddDone: () => void;
  selected: string | null;
  onOpen: (card: CardView) => void;
}) {
  const { column, cards, collapsed, settings } = props;
  const { setNodeRef } = useDroppable({ id: COLUMN_PREFIX + column.id });
  const form = (
    <>
      {props.adding && <NewCardForm status={column.id} onDone={props.onAddDone} />}
      <PendingCardList status={column.id} />
    </>
  );
  return (
    <section className={`column ${collapsed ? 'collapsed' : ''}`} style={{ '--column-color': column.color } as React.CSSProperties}>
      {props.top}
      <ColumnHeader
        name={column.name}
        status={column.id}
        drag={props.drag}
        count={cards.length}
        total={props.total}
        collapsed={collapsed}
        onToggle={props.onToggle}
        onAdd={props.onAdd}
      />
      {!collapsed && (
        <SortableContext items={cards.map((c) => c.fields.id!)} strategy={verticalListSortingStrategy}>
          <div className="cards" ref={setNodeRef}>
            {settings.addNewCardsToTop && form}
            {cards.map((card) => (
              <SortableCard
                key={card.fields.id}
                card={card}
                settings={settings}
                selected={card.fields.id === props.selected}
                onOpen={props.onOpen}
              />
            ))}
            {!settings.addNewCardsToTop && form}
          </div>
        </SortableContext>
      )}
    </section>
  );
}

/** The collapse control for columns and lanes: the only thing that collapses them. */
function Chevron(props: { collapsed: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      className="chevron-button"
      onClick={props.onToggle}
      aria-expanded={!props.collapsed}
      aria-label={`${props.collapsed ? 'Expand' : 'Collapse'} ${props.label}`}
      title={props.collapsed ? 'Expand' : 'Collapse'}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className={props.collapsed ? 'collapsed' : ''}>
        <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

/** Column drag-to-reorder, shared by the headers (browser drag and drop, separate from card dragging). */
export interface ColumnDrag {
  dragging: string | null;
  setDragging: (id: string | null) => void;
  drop: (target: string) => void;
}

function useColumnDrag(ids: string[]): ColumnDrag {
  const [dragging, setDragging] = useState<string | null>(null);
  return {
    dragging,
    setDragging,
    drop: (target) => {
      const dragged = dragging;
      setDragging(null);
      if (!dragged || dragged === target) return;
      vscode.postMessage({ type: 'columnOrder', order: reorderLanes(ids, dragged, target) });
    },
  };
}

/**
 * A column's header: drag handle (reorder), chevron (collapse; the only thing
 * that collapses), title (click to rename), count, and + for a new card.
 * Right-click: rename, colour, move all, archive all, delete.
 */
function ColumnHeader(props: {
  name: string;
  /** The column's status (id): its right-click menu, rename and drag need it. */
  status?: string;
  count: number;
  /** Cards in the column including those a filter hides; shown as "count / total". */
  total?: number | null;
  collapsed: boolean;
  onToggle: () => void;
  onAdd?: () => void;
  drag?: ColumnDrag;
}) {
  const { status, drag } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.name);
  const [over, setOver] = useState(false);
  const commit = () => {
    setEditing(false);
    const to = draft.trim();
    if (status && to && to !== props.name) vscode.postMessage({ type: 'columnCommand', action: 'rename', status, to });
  };
  return (
    <div
      className={`column-header ${over && drag?.dragging && drag.dragging !== status ? 'drop-target' : ''}`}
      data-vscode-context={status ? JSON.stringify({ webviewSection: 'column', status, preventDefaultContextMenuItems: true }) : undefined}
      onDragOver={(e) => {
        if (!drag?.dragging) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (status && drag?.dragging) drag.drop(status);
      }}
    >
      {status && drag && (
        <span
          className="column-grip"
          draggable
          title="Drag to reorder columns"
          aria-label={`Reorder column ${props.name}`}
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', status);
            drag.setDragging(status);
          }}
          onDragEnd={() => drag.setDragging(null)}
        >
          ⋮⋮
        </span>
      )}
      <div className="column-title">
        <Chevron collapsed={props.collapsed} onToggle={props.onToggle} label={props.name} />
        <span className="dot" aria-hidden />
        {editing ? (
          <input
            className="column-name-input"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') {
                e.stopPropagation();
                setDraft(props.name);
                setEditing(false);
              }
            }}
            aria-label={`New name for column ${props.name}`}
          />
        ) : status ? (
          <button
            type="button"
            className="name column-name"
            title="Click to rename"
            onClick={() => {
              setDraft(props.name);
              setEditing(true);
            }}
          >
            {props.name}
          </button>
        ) : (
          <span className="name">{props.name}</span>
        )}
        <span className="count">
          {props.total != null && props.total !== props.count ? `${props.count} / ${props.total}` : props.count}
        </span>
      </div>
      {props.onAdd && (
        <button type="button" className="add" onClick={props.onAdd} title="New card (N)" aria-label={`New card in ${props.name}`}>
          +
        </button>
      )}
    </div>
  );
}

/** First run: no board in this project yet. Nothing is created until the user asks. */
function Welcome(props: { featuresDirectory: string; folderOpen: boolean; layout: Layout }) {
  const setup = (action: 'create' | 'choose' | 'openFolder') => vscode.postMessage({ type: 'setupBoard', action });
  return (
    <div className={`welcome ${props.layout}`}>
      <h2>No board in this project yet</h2>
      {props.folderOpen ? (
        <>
          <p>
            KanbanBananas keeps each card as a markdown file in <code>{props.featuresDirectory}/</code> (done cards in{' '}
            <code>done/</code>). Create that folder to start a board, or use a folder that already holds cards.
          </p>
          <div className="welcome-actions">
            <button type="button" className="primary" onClick={() => setup('create')}>
              Create board
            </button>
            <button type="button" className="tool" onClick={() => setup('choose')}>
              Use an existing folder…
            </button>
          </div>
        </>
      ) : (
        <>
          <p>Open your project folder first; the board lives inside it.</p>
          <div className="welcome-actions">
            <button type="button" className="primary" onClick={() => setup('openFolder')}>
              Open Folder…
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** A dashed placeholder after the last column. */
function AddColumn() {
  return (
    <button type="button" className="add-column" onClick={() => vscode.postMessage({ type: 'columnCommand', action: 'new' })}>
      + Add column
    </button>
  );
}

function NewCardForm({ status, onDone }: { status: string; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const { create } = usePendingCards();
  const submit = () => {
    if (title.trim()) create(title.trim(), status);
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

function SortableCard(props: { card: CardView; settings: ViewSettings; selected: boolean; onOpen: (card: CardView) => void }) {
  const { card, settings } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: card.fields.id! });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? 'drag-source' : undefined}
      {...attributes}
      {...listeners}
    >
      <CardBody card={card} settings={settings} selected={props.selected} onOpen={props.onOpen} />
    </div>
  );
}

function CardBody(props: {
  card: CardView;
  settings: ViewSettings;
  dragging?: boolean;
  selected?: boolean;
  onOpen: (card: CardView) => void;
}) {
  const { card, settings, dragging } = props;
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
      className={`card ${dragging ? 'dragging' : ''} ${props.selected ? 'selected' : ''}`}
      aria-pressed={props.selected}
      title={card.path}
      // Right-click menu: VS Code reads this and shows the kanbanBananas.card.* commands.
      data-vscode-context={JSON.stringify({ webviewSection: 'card', cardId: fields.id, preventDefaultContextMenuItems: true })}
      onClick={() => props.onOpen(card)}
    >
      <div className="title-row">
        <span className="title">{card.title ?? card.filename}</span>
        {!dragging && <CopyPath path={card.path} />}
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
          {show.epic && fields.epic && (
            <span className="epic" style={{ '--epic-color': laneColor('epic', fields.epic, settings.lanes?.epic ?? [], settings.epicColors) } as React.CSSProperties}>
              {fields.epic}
            </span>
          )}
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
