import { DEFAULT_COLUMNS, type ColumnConfig, type ViewSettings } from '@kanban-bananas/core';
import * as vscode from 'vscode';

export const SECTION = 'kanbanBananas';
/** Settings of the extension this one replaces. Read as a fallback, never written. */
const LEGACY_SECTION = 'kanban-markdown';

export interface Settings {
  featuresDirectory: string;
  defaultPriority: string;
  view: ViewSettings;
}

export function readSettings(): Settings {
  const config = vscode.workspace.getConfiguration(SECTION);
  const legacy = vscode.workspace.getConfiguration(LEGACY_SECTION);

  /** Our value if the user set it anywhere, else the legacy value if set, else our default. */
  function get<T>(key: string, legacyKey = key): T {
    if (isSet(config.inspect<T>(key))) return config.get<T>(key)!;
    const old = legacy.inspect<T>(legacyKey);
    if (isSet(old)) return legacy.get<T>(legacyKey)!;
    return config.get<T>(key)!;
  }

  return {
    featuresDirectory: get<string>('featuresDirectory'),
    defaultPriority: get<string>('defaultPriority'),
    view: {
      columns: validColumns(get<unknown>('columns')),
      compactMode: get<boolean>('compactMode'),
      addNewCardsToTop: get<boolean>('addNewCardsToTop'),
      show: {
        priority: get<boolean>('showPriority'),
        assignee: get<boolean>('showAssignee'),
        dueDate: get<boolean>('showDueDate'),
        labels: get<boolean>('showLabels'),
        epic: get<boolean>('showEpic'),
        filename: get<boolean>('showFilename'),
      },
    },
  };
}

function isSet(
  i: { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown } | undefined,
): boolean {
  return (
    i !== undefined &&
    (i.globalValue !== undefined || i.workspaceValue !== undefined || i.workspaceFolderValue !== undefined)
  );
}

function validColumns(value: unknown): ColumnConfig[] {
  if (!Array.isArray(value)) return [...DEFAULT_COLUMNS];
  const columns = value
    .filter((c): c is { id: string; name?: unknown; color?: unknown } => typeof c?.id === 'string' && c.id !== '')
    .map((c) => ({
      id: c.id,
      name: typeof c.name === 'string' ? c.name : c.id,
      color: typeof c.color === 'string' ? c.color : '#6b7280',
    }));
  return columns.length > 0 ? columns : [...DEFAULT_COLUMNS];
}
