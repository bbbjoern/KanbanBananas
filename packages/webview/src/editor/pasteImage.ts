/**
 * Turning a pasted or dropped image into what the host stores: lossless WebP
 * (or PNG), optionally scaled down. GIFs and SVGs are kept as they are
 * (animation, vectors). Runs in the page, where the browser can encode images.
 */
export interface PreparedImage {
  ext: string;
  /** base64, no data: prefix */
  data: string;
}

export function imageFiles(list: FileList | null | undefined): File[] {
  return [...(list ?? [])].filter((f) => /^image\/(png|jpe?g|gif|webp|svg\+xml)$/.test(f.type));
}

export async function prepareImage(file: File, format: 'webp' | 'png', maxWidth: number): Promise<PreparedImage> {
  if (file.type === 'image/gif' || file.type === 'image/svg+xml') {
    return { ext: file.type === 'image/gif' ? 'gif' : 'svg', data: await toBase64(file) };
  }
  const bitmap = await createImageBitmap(file);
  const scale = maxWidth > 0 && bitmap.width > maxWidth ? maxWidth / bitmap.width : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const g = canvas.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  // Quality 1 makes Chromium's WebP lossless: pixel-identical, and usually smaller than PNG.
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, format === 'webp' ? 'image/webp' : 'image/png', 1));
  if (!blob) throw new Error('The image could not be encoded.');
  // Not always, though: when the pasted original (unscaled) is already smaller in a lossless format, keep it.
  const original = scale === 1 && (file.type === 'image/png' || file.type === 'image/webp') && file.size <= blob.size;
  if (original) return { ext: file.type === 'image/png' ? 'png' : 'webp', data: await toBase64(file) };
  return { ext: blob.type === 'image/webp' ? 'webp' : 'png', data: await toBase64(blob) };
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** The text to insert for an image link at `pos`: on a line of its own. */
export function imageInsert(doc: string, pos: number, link: string): string {
  const before = pos > 0 && doc[pos - 1] !== '\n' ? '\n' : '';
  const after = pos < doc.length && doc[pos] !== '\n' ? '\n' : '';
  return `${before}![](${link})${after}`;
}
