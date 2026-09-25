import { idForFilename } from './filenames.js';
import type { Card, KnownField } from './parse.js';

/** Fields every card must have. */
export const REQUIRED_FIELDS: readonly KnownField[] = ['id', 'status'];

export const DONE_STATUS = 'done';
export const DONE_DIR = 'done';

export type IssueCode =
  | 'missing-field'
  | 'invalid-field'
  | 'id-mismatch'
  | 'duplicate-id'
  | 'unknown-status'
  | 'wrong-folder';

export interface Issue {
  code: IssueCode;
  severity: 'error' | 'warning';
  message: string;
  field?: KnownField;
}

export interface CardLocation {
  /** Basename, e.g. `fix-login-2026-09-01.md`. */
  filename: string;
  /** Directory relative to the features directory: `''`, `'done'` or `'archived'`. */
  dir: string;
}

export interface ValidateOptions {
  /** Column ids. When given, a status outside this list is an error. */
  statuses?: readonly string[];
}

export function validateCard(card: Card, at: CardLocation, opts: ValidateOptions = {}): Issue[] {
  const issues: Issue[] = [];
  const f = card.fields;

  for (const p of card.fieldProblems) {
    issues.push({ code: 'invalid-field', severity: 'error', field: p.field, message: `${p.field}: ${p.message}` });
  }
  for (const field of REQUIRED_FIELDS) {
    const invalid = card.fieldProblems.some((p) => p.field === field);
    if (!invalid && f[field] === null) {
      issues.push({ code: 'missing-field', severity: 'error', field, message: `Missing required field \`${field}\`.` });
    }
  }

  const expectedId = idForFilename(at.filename);
  if (f.id !== null && f.id !== expectedId) {
    issues.push({
      code: 'id-mismatch',
      severity: 'error',
      field: 'id',
      message: `id is "${f.id}" but the filename says "${expectedId}".`,
    });
  }

  if (f.status !== null && opts.statuses && !opts.statuses.includes(f.status)) {
    issues.push({ code: 'unknown-status', severity: 'error', field: 'status', message: `Unknown status "${f.status}".` });
  }

  if (f.status !== null && at.dir !== 'archived') {
    const inDone = at.dir === DONE_DIR;
    if (inDone !== (f.status === DONE_STATUS)) {
      issues.push({
        code: 'wrong-folder',
        severity: 'warning',
        field: 'status',
        message: inDone
          ? `Card is in ${DONE_DIR}/ but its status is "${f.status}".`
          : `Card has status "${DONE_STATUS}" but is not in ${DONE_DIR}/.`,
      });
    }
  }

  return issues;
}
