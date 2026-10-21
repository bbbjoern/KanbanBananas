import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { assetPathOk } from '../hubSync.js';
import type { HubImageSettings } from '../hubProtocol.js';

/**
 * Where the hub client reads the images the cards refer to (`HubClientOptions.assets`):
 * the repo root on disk and the images folder under it. `stat` lets the
 * client reuse a hash while a file's size and mtime stand; `read` gives the
 * bytes to hash and upload. Both refuse a path outside the folder, whatever
 * the caller was given.
 */
export interface HubAssetSource {
  images: HubImageSettings;
  stat(path: string): Promise<{ size: number; mtimeMs: number } | null>;
  read(path: string): Promise<Uint8Array>;
}

export function fsAssetSource(root: string, images: HubImageSettings): HubAssetSource {
  const folder = images.folder.replace(/^\/+|\/+$/g, '');
  const file = (path: string): string => {
    if (!assetPathOk(path, folder)) throw new Error(`Not an asset path under ${folder}: ${path}`);
    return join(root, ...path.split('/'));
  };
  return {
    images: { ...images, folder },
    async stat(path) {
      try {
        const s = await stat(file(path));
        return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null;
      } catch {
        return null;
      }
    },
    read: async (path) => readFile(file(path)),
  };
}
