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

/** Default filename pattern: `<slug>-<YYYY-MM-DD>.md`. */
export function cardFilename(title: string, date: Date): string {
  const slug = slugify(title) || 'card';
  return `${slug}-${date.toISOString().slice(0, 10)}.md`;
}
