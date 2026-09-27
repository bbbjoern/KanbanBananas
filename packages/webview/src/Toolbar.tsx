import type { CardView, GroupField } from '@kanban-bananas/core';
import { useEffect, useRef } from 'react';
import type { GroupBy, Layout } from './App.js';
import { distinct, filtersActive, NO_FILTERS, UNLABELLED, type Filters } from './filters.js';
import { vscode } from './vscode.js';

const PRIORITIES = ['critical', 'high', 'medium', 'low'];

/** Search, filters, epic lanes and label management (spec §5). `/` focuses the search. */
export function Toolbar(props: {
  layout: Layout;
  cards: CardView[];
  filters: Filters;
  onFilters: (f: Filters) => void;
  groupBy: GroupBy;
  onGroupBy: (g: GroupBy) => void;
  shown: number;
}) {
  const { filters, cards } = props;
  const search = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<Filters>) => props.onFilters({ ...filters, ...patch });
  const assignees = distinct(cards, (c) => [c.fields.assignee]);
  const labels = distinct(cards, (c) => c.fields.labels);
  const active = filtersActive(filters);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== '/' || e.metaKey || e.ctrlKey || (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) return;
      e.preventDefault();
      search.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={`toolbar ${props.layout}`}>
      <input
        ref={search}
        className="search"
        type="search"
        placeholder="Search cards  /"
        aria-label="Search cards"
        value={filters.query}
        onChange={(e) => set({ query: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            set({ query: '' });
            e.currentTarget.blur();
          }
        }}
      />
      <select aria-label="Priority" className={filters.priority ? 'on' : ''} value={filters.priority ?? ''} onChange={(e) => set({ priority: e.target.value || null })}>
        <option value="">Priority</option>
        {PRIORITIES.map((p) => (
          <option key={p} value={p}>
            {p[0]!.toUpperCase() + p.slice(1)}
          </option>
        ))}
      </select>
      {assignees.length > 0 && (
        <select aria-label="Assignee" className={filters.assignee ? 'on' : ''} value={filters.assignee ?? ''} onChange={(e) => set({ assignee: e.target.value || null })}>
          <option value="">Assignee</option>
          {assignees.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      )}
      <select aria-label="Label" className={filters.label ? 'on' : ''} value={filters.label ?? ''} onChange={(e) => set({ label: e.target.value || null })}>
        <option value="">Label</option>
        <option value={UNLABELLED}>No label</option>
        {labels.map((l) => (
          <option key={l} value={l}>
            {l}
          </option>
        ))}
      </select>
      <select
        aria-label="Due date"
        className={filters.due ? 'on' : ''}
        value={filters.due ?? ''}
        onChange={(e) => set({ due: (e.target.value || null) as Filters['due'] })}
      >
        <option value="">Due</option>
        <option value="overdue">Overdue</option>
        <option value="today">Today</option>
        <option value="week">This week</option>
        <option value="none">No due date</option>
      </select>
      {active && (
        <button type="button" className="tool" onClick={() => props.onFilters(NO_FILTERS)}>
          Clear · {props.shown} shown
        </button>
      )}
      <span className="spacer" />
      {props.layout === 'panel' && (
        <select
          aria-label="Group by"
          className={props.groupBy !== 'none' ? 'on' : ''}
          value={props.groupBy}
          onChange={(e) => props.onGroupBy(e.target.value as GroupBy)}
        >
          <option value="none">No swimlanes</option>
          <option value="epic">Swimlanes: Epic</option>
          <option value="assignee">Swimlanes: Assignee</option>
          <option value="priority">Swimlanes: Priority</option>
          <option value="lane">Swimlanes: Lane field</option>
        </select>
      )}
      {props.layout === 'panel' && (
        <button type="button" className="tool add-lane" onClick={() => vscode.postMessage({ type: 'columnCommand', action: 'new' })}>
          + Column
        </button>
      )}
      {props.layout === 'panel' && props.groupBy !== 'none' && (
        <button type="button" className="tool add-lane" onClick={() => vscode.postMessage({ type: 'laneCommand', action: 'new', field: props.groupBy as GroupField })}>
          + Swimlane
        </button>
      )}
      <select
        aria-label="Manage labels"
        className="tool-select"
        value=""
        onChange={(e) => {
          const action = e.target.value as 'rename' | 'delete' | '';
          if (action) vscode.postMessage({ type: 'labelCommand', action });
        }}
      >
        <option value="">Labels…</option>
        <option value="rename">Rename a label…</option>
        <option value="delete">Delete a label…</option>
      </select>
      <button
        type="button"
        className="tool icon settings"
        title={`KanbanBananas settings (board ${__BOARD_BUILD__})`}
        aria-label="KanbanBananas settings"
        onClick={() => vscode.postMessage({ type: 'openSettings' })}
      >
        ⚙
      </button>
    </div>
  );
}
