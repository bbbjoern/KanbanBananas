import { DEFAULT_COLUMNS, DEFAULT_FILENAME_PATTERN, DEFAULT_IMAGES_FOLDER, GROUP_FIELDS, isValidFilenamePattern, type ColumnConfig, type GroupField, type LaneDef, type ViewSettings } from '@kanban-bananas/core';
import * as vscode from 'vscode';

export const SECTION = 'kanbanBananas';
/** Settings of the extension this one replaces. Read as a fallback, never written. */
const LEGACY_SECTION = 'kanban-markdown';

export interface Settings {
  featuresDirectory: string;
  /** Images folder, relative to the workspace folder. */
  imagesFolder: string;
  defaultPriority: string;
  /** Column for new cards from commands and N. */
  defaultStatus: string;
  filenamePattern: string;
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

  const pattern = get<string>('filenamePattern');
  const settings: Settings = {
    featuresDirectory: get<string>('featuresDirectory'),
    imagesFolder: (get<string>('images.folder') || DEFAULT_IMAGES_FOLDER).replace(/^\/+|\/+$/g, ''),
    defaultPriority: get<string>('defaultPriority'),
    defaultStatus: '',
    filenamePattern: '',
    view: {
      columns: validColumns(get<unknown>('columns')),
      compactMode: get<boolean>('compactMode'),
      addNewCardsToTop: get<boolean>('addNewCardsToTop'),
      epicColors: validColors(get<unknown>('epicColors')),
      lanes: validLanes(get<unknown>('lanes')),
      layout: get<string>('layout') === 'vertical' ? 'vertical' : 'horizontal',
      hideScrollbars: get<boolean>('hideScrollbars'),
      defaultStatus: '',
      images: {
        format: get<string>('images.format') === 'png' ? 'png' : 'webp',
        maxWidth: Math.max(0, Math.floor(Number(get<number>('images.maxWidth')) || 0)),
      },
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
  const status = get<string>('defaultStatus');
  settings.defaultStatus = settings.view.columns.some((c) => c.id === status) ? status : settings.view.columns[0]!.id;
  settings.filenamePattern = isValidFilenamePattern(pattern) ? pattern : DEFAULT_FILENAME_PATTERN;
  settings.view.defaultStatus = settings.defaultStatus;
  return settings;
}

function isSet(
  i: { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown } | undefined,
): boolean {
  return (
    i !== undefined &&
    (i.globalValue !== undefined || i.workspaceValue !== undefined || i.workspaceFolderValue !== undefined)
  );
}

function validLanes(value: unknown): Record<GroupField, LaneDef[]> {
  const out = Object.fromEntries(GROUP_FIELDS.map((f) => [f, [] as LaneDef[]])) as Record<GroupField, LaneDef[]>;
  if (!value || typeof value !== 'object') return out;
  for (const field of GROUP_FIELDS) {
    const list = (value as Record<string, unknown>)[field];
    if (!Array.isArray(list)) continue;
    const seen = new Set<string>();
    let none = false;
    for (const item of list) {
      if (item?.none === true && !none) {
        none = true;
        out[field].push({ name: '', none: true });
        continue;
      }
      const name = typeof item?.name === 'string' ? item.name.trim() : '';
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out[field].push(typeof item.color === 'string' ? { name, color: item.color } : { name });
    }
  }
  return out;
}

function validColors(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === 'string'));
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
