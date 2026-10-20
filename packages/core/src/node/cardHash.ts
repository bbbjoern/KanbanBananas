import { createHash } from 'node:crypto';
import type { BoardFile } from '../board.js';
import { idForFilename } from '../filenames.js';
import type { CardDigest, CardText } from '../hubProtocol.js';

/**
 * A card's version for the hub protocol: the SHA-256 of its bytes, as hex.
 * Given text, the UTF-8 encoding is hashed, which is the file's bytes for any
 * valid UTF-8 file (BOM and CRLF included). Node-only because of node:crypto;
 * the webview never hashes, it gets hashes from the hub.
 */
export function cardHash(text: string | Uint8Array): string {
  return createHash('sha256')
    .update(typeof text === 'string' ? Buffer.from(text, 'utf8') : text)
    .digest('hex');
}

/** Id, path and hash of every file, for `hello`. The id is the filename without `.md`. */
export function cardDigests(files: readonly BoardFile[]): CardDigest[] {
  return files.map((f) => ({ id: idForFile(f.path), path: f.path, hash: cardHash(f.text) }));
}

/** The files as the hub stores them, for `cards` and the change events. */
export function cardTexts(files: readonly BoardFile[]): CardText[] {
  return files.map((f) => ({ id: idForFile(f.path), path: f.path, hash: cardHash(f.text), text: f.text }));
}

/** Does the hash match the text? A receiver's check against a corrupted or mislabelled message. */
export function verifyCardText(card: CardText): boolean {
  return cardHash(card.text) === card.hash;
}

function idForFile(path: string): string {
  return idForFilename(path.slice(path.lastIndexOf('/') + 1));
}
