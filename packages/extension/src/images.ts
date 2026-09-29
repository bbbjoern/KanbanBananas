import { IMAGE_EXTENSIONS, imageFileName, imageLink, imageRefs, loadBoard, parseCard } from '@kanban-bananas/core';
import { ConflictError, exists, writeAtomic } from '@kanban-bananas/core/node';
import { mkdir, readdir, rmdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import * as vscode from 'vscode';
import type { BoardController } from './controller.js';
import { log } from './log.js';

/** Largest image accepted from a paste or drop. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Pasted images (screenshots): stored per card under the images folder
 * (`.devtool/assets/<card-id>/…`) and linked from the project root, so links
 * survive moving a card to done/. Deleting a card deletes the images only it
 * uses; images other cards (active or archived) link to are kept.
 */
export class CardImages {
  constructor(private readonly controller: BoardController) {}

  /** The workspace folder holding the board; image links are relative to it. */
  private workspaceRoot(): string {
    const root = this.controller.root;
    const folder = root && vscode.workspace.getWorkspaceFolder(root);
    if (!folder) throw new Error('No board folder in this workspace.');
    return folder.uri.fsPath;
  }

  private folder(): string {
    return this.controller.settingsNow.imagesFolder;
  }

  /** Save image bytes for a card; returns the link to put in the card. Never overwrites a file. */
  async save(cardId: string, bytes: Uint8Array, ext: string): Promise<string> {
    const type = ext.toLowerCase().replace(/^\./, '').replace('jpeg', 'jpg');
    if (!IMAGE_EXTENSIONS.includes(type)) throw new Error(`Not an image type the board stores: ${ext}.`);
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`The image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
    if (!/^[\w.-]+$/.test(cardId)) throw new Error(`Unexpected card id "${cardId}".`);

    const root = this.workspaceRoot();
    const dir = join(root, ...this.folder().split('/'), cardId);
    await mkdir(dir, { recursive: true });
    const name = imageFileName(new Date(), type);
    const stem = name.slice(0, -(type.length + 1));
    for (let n = 1; ; n++) {
      const file = join(dir, n === 1 ? name : `${stem}-${n}.${type}`);
      if (await exists(file)) continue;
      try {
        await writeAtomic(file, bytes, null);
      } catch (e) {
        if (e instanceof ConflictError) continue;
        throw e;
      }
      const link = imageLink(relative(root, file).split(sep).join('/'));
      log.info(`Saved image for ${cardId}: ${link} (${Math.round(bytes.length / 1024)} KB)`);
      return link;
    }
  }

  /** Every image path (project-relative) linked by any card, active or archived, optionally leaving one card out. */
  async referenced(exceptCardId?: string): Promise<Map<string, string[]>> {
    const byPath = new Map<string, string[]>();
    const add = (id: string, body: string) => {
      if (id === exceptCardId) return;
      for (const ref of imageRefs(body)) byPath.set(ref, [...(byPath.get(ref) ?? []), id]);
    };
    for (const c of this.controller.board()?.cards ?? []) {
      const text = this.controller.cardText(c.path);
      const parsed = text !== undefined ? parseCard(text) : null;
      add(c.card.fields.id!, parsed?.ok ? parsed.card.source.body : c.card.source.body);
    }
    const archived = loadBoard(await this.controller.archivedFiles());
    for (const c of archived.cards) add(c.card.fields.id!, c.card.source.body);
    return byPath;
  }

  /** Images in the images folder linked by this card: those only it uses, and those other cards use too. */
  async ofCard(cardId: string): Promise<{ own: string[]; shared: string[] }> {
    const card = this.controller.board()?.cards.find((c) => c.card.fields.id === cardId);
    if (!card) return { own: [], shared: [] };
    const text = this.controller.cardText(card.path);
    const parsed = text !== undefined ? parseCard(text) : null;
    const body = parsed?.ok ? parsed.card.source.body : card.card.source.body;
    const prefix = `${this.folder()}/`;
    const mine = imageRefs(body).filter((r) => r.startsWith(prefix));
    const others = await this.referenced(cardId);
    const own: string[] = [];
    const shared: string[] = [];
    for (const ref of mine) (others.has(ref) ? shared : own).push(ref);
    return { own, shared };
  }

  /** Every file in the images folder no card links to. */
  async unused(): Promise<string[]> {
    const root = this.workspaceRoot();
    const base = join(root, ...this.folder().split('/'));
    const files = await listFiles(base);
    const used = await this.referenced();
    return files.map((f) => relative(root, f).split(sep).join('/')).filter((p) => !used.has(p));
  }

  /** Delete images (project-relative paths), then any card folders left empty. */
  async delete(paths: string[], permanently: boolean): Promise<void> {
    const root = this.workspaceRoot();
    const folders = new Set<string>();
    for (const p of paths) {
      const file = join(root, ...p.split('/'));
      await vscode.workspace.fs.delete(vscode.Uri.file(file), { useTrash: !permanently });
      folders.add(join(file, '..'));
    }
    for (const dir of folders) await rmdir(dir).catch(() => {}); // only succeeds when empty
    if (paths.length) log.info(`Deleted ${paths.length} image(s)${permanently ? ' permanently' : ''}: ${paths.join(', ')}`);
  }
}

async function listFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(full)));
    else if (e.isFile() && !e.name.startsWith('.')) out.push(full);
  }
  return out;
}

/**
 * Paste and drop of images into a card opened in VS Code's own editor: saved
 * the same way, with the same root-relative link. Only answers for card files;
 * other markdown keeps VS Code's own behaviour.
 */
export function registerImagePasteAndDrop(controller: BoardController, images: CardImages): vscode.Disposable {
  const kind = vscode.DocumentDropOrPasteEditKind.Empty.append('markdown', 'link', 'image', 'kanbanBananas');
  const mimeTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'files'];

  const edit = async (doc: vscode.TextDocument, dataTransfer: vscode.DataTransfer): Promise<string | undefined> => {
    const cardId = controller.cardIdForDocument(doc.uri);
    if (!cardId) return undefined;
    const links: string[] = [];
    for (const [mime, item] of dataTransfer) {
      const file = item.asFile();
      const ext = extensionFor(mime, file?.name);
      if (!file || !ext) continue;
      links.push(await images.save(cardId, await file.data(), ext));
    }
    return links.length ? links.map((l) => `![](${l})`).join('\n') : undefined;
  };

  return vscode.Disposable.from(
    vscode.languages.registerDocumentPasteEditProvider(
      { language: 'markdown' },
      {
        async provideDocumentPasteEdits(doc, _ranges, dataTransfer) {
          const text = await edit(doc, dataTransfer);
          return text ? [new vscode.DocumentPasteEdit(text, 'Insert image (KanbanBananas)', kind)] : undefined;
        },
      },
      { providedPasteEditKinds: [kind], pasteMimeTypes: mimeTypes },
    ),
    vscode.languages.registerDocumentDropEditProvider(
      { language: 'markdown' },
      {
        async provideDocumentDropEdits(doc, _position, dataTransfer) {
          const text = await edit(doc, dataTransfer);
          if (!text) return undefined;
          const drop = new vscode.DocumentDropEdit(text, 'Insert image (KanbanBananas)', kind);
          return drop;
        },
      },
      { providedDropEditKinds: [kind], dropMimeTypes: mimeTypes },
    ),
  );
}

function extensionFor(mime: string, name: string | undefined): string | null {
  const fromName = name?.match(/\.(png|webp|jpe?g|gif|svg)$/i)?.[1]?.toLowerCase();
  if (fromName) return fromName;
  const fromMime = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' }[mime];
  return fromMime ?? null;
}
