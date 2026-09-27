export const MAX_SLUG_LENGTH = 50;

/**
 * The id a card with this filename must have: the filename without `.md`.
 * Confirmed against all 108 corpus cards.
 */
export function idForFilename(filename: string): string {
  return filename.replace(/\.md$/i, '');
}

/** Lowercase `[a-z0-9-]`, no leading, trailing or repeated dashes, at most 50 characters. */
export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\u00df/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, MAX_SLUG_LENGTH).replace(/-+$/, '');
}

/**
 * Filename patterns: `{slug}` is required, `{date}` is YYYY-MM-DD. The
 * default is the old board's `{slug}-{date}` (spec §3).
 */
export const DEFAULT_FILENAME_PATTERN = '{slug}-{date}';

export function isValidFilenamePattern(pattern: string): boolean {
  return pattern.includes('{slug}') && /^[a-z0-9{}_-]+$/i.test(pattern) && !/\{(?!slug\}|date\})/.test(pattern);
}

/** A card's filename from its title and date, e.g. `fix-login-2026-09-01.md`. */
export function cardFilename(title: string, date: Date, pattern: string = DEFAULT_FILENAME_PATTERN): string {
  const slug = slugify(title) || 'card';
  const p = isValidFilenamePattern(pattern) ? pattern : DEFAULT_FILENAME_PATTERN;
  return `${p.replaceAll('{slug}', slug).replaceAll('{date}', date.toISOString().slice(0, 10))}.md`;
}
