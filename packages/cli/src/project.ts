import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DEFAULT_COLUMNS, SOCKET_RECORD } from '@kanban-bananas/core';

/** `.devtool/kanban.json`: optional project settings and agent policy, enforced by the CLI. */
export interface ProjectConfig {
  /** Relative to the project root. Default `.devtool/features`. */
  featuresDirectory?: string;
  /** Valid statuses (column ids). Default: the five standard columns. */
  statuses?: string[];
  addNewCardsToTop?: boolean;
  defaultPriority?: string;
  agents?: {
    /** Statuses the CLI may move or create cards into without `--force`. */
    allowStatus?: string[];
  };
}

export interface Project {
  /** The project root: the folder holding `.devtool` (session memory paths are relative to it). */
  root: string;
  /** Absolute path of the features directory. */
  features: string;
  /** Where the running extension records its socket. */
  socketRecord: string;
  config: ProjectConfig;
  statuses: string[];
  /** Column names on the board, by status, when the extension provided them. */
  columnNames?: Record<string, string>;
}

export class UsageError extends Error {
  override name = 'UsageError';
}

/**
 * Find the board: `--dir`/`KANBAN_DIR` if given, else the nearest `.devtool`
 * folder above the current directory.
 */
export function findProject(cwd: string, dirOption: string | undefined): Project {
  if (dirOption) {
    const features = resolve(cwd, dirOption);
    if (!isDir(features)) throw new UsageError(`Not a directory: ${features}`);
    // With --dir the root isn't known; assume the default layout, <root>/.devtool/features.
    return project(dirname(dirname(features)), features, readConfig(join(dirname(features), 'kanban.json')));
  }
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const devtool = join(dir, '.devtool');
    if (isDir(devtool)) {
      const config = readConfig(join(devtool, 'kanban.json'));
      const features = resolve(dir, config.featuresDirectory ?? '.devtool/features');
      if (!isDir(features)) throw new UsageError(`No features directory at ${features}.`);
      return project(dir, features, config);
    }
    if (dirname(dir) === dir) break;
  }
  throw new UsageError('No .devtool folder found here or above. Run this inside the project, or pass --dir <features dir>.');
}

function project(root: string, features: string, config: ProjectConfig): Project {
  return {
    root,
    features,
    socketRecord: join(dirname(features), SOCKET_RECORD),
    config,
    statuses: config.statuses?.length ? config.statuses : DEFAULT_COLUMNS.map((c) => c.id),
  };
}

function readConfig(path: string): ProjectConfig {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ProjectConfig;
  } catch (e) {
    throw new UsageError(`Can't read ${path}: ${(e as Error).message}`);
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
