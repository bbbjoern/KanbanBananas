/**
 * Images pasted into cards (screenshots). They live in one folder per card
 * under the images folder (default `.devtool/assets/<card-id>/`), and cards
 * link them from the project root: `![](/.devtool/assets/<card-id>/…)`.
 * Root-relative links keep working when a card moves to `done/`, and resolve
 * the same in VS Code's preview and on GitHub.
 */

export const DEFAULT_IMAGES_FOLDER = '.devtool/assets';
export const IMAGE_FORMATS = ['webp', 'png'] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];

/** Extensions the board accepts and serves as images. */
export const IMAGE_EXTENSIONS = ['png', 'webp', 'jpg', 'jpeg', 'gif', 'svg'];

/** `2026-09-29-143012.webp`: sortable, readable, unique enough per card (a clash gets a suffix). */
export function imageFileName(now: Date, ext: string): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp}.${ext}`;
}

/** The link a card gets for an image at `path` (relative to the project root). */
export function imageLink(path: string): string {
  return `/${path.replace(/^\/+/, '')}`;
}

/**
 * Image paths a card body refers to, as project-relative paths without the
 * leading `/`: markdown images `![alt](/path)` and HTML `<img src="/path">`.
 * Only root-relative links (ours) are returned; web links and relative ones aren't.
 */
export function imageRefs(body: string): string[] {
  const refs = new Set<string>();
  for (const m of body.matchAll(/!\[[^\]]*\]\(\s*<?(\/[^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) refs.add(decode(m[1]!));
  for (const m of body.matchAll(/<img\b[^>]*\bsrc=["'](\/[^"']+)["']/gi)) refs.add(decode(m[1]!));
  return [...refs].map((r) => r.replace(/^\/+/, ''));
}

function decode(s: string): string {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}
