import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import { Annotation, Compartment, EditorState, Prec, Transaction, type ChangeSet } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { useEffect, useRef, useState } from 'react';
import { BodySync } from '../bodySync.js';
import { ACK_TIMEOUT_MS, markDisconnected, onReconnect } from '../connection.js';
import { onHostMessage, vscode } from '../vscode.js';
import { assetBase, livePreview } from './livePreview.js';
import { imageFiles, imageInsert, prepareImage } from './pasteImage.js';

const SAVE_DELAY_MS = 500;

/** Marks transactions that come from the host, so they aren't treated as the user's typing. */
const fromHost = Annotation.define<boolean>();

const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: '600' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.processingInstruction, tags.meta, tags.url], color: 'var(--muted)' },
  { tag: tags.link, color: 'var(--link)' },
  { tag: tags.monospace, fontFamily: 'var(--vscode-editor-font-family, monospace)' },
]);

type Conflict = { theirs: string };

/**
 * The card body in CodeMirror, kept in step with the file by BodySync. The
 * editor is uncontrolled: React never passes the text back in, and outside
 * changes are applied as small transactions (spec §7).
 */
export function InlineEditor(props: {
  id: string;
  live: boolean;
  onEscape: () => void;
  /** How pasted images are stored. */
  images: { format: 'webp' | 'png'; maxWidth: number };
  /** Where the page can load project files from, for showing `/…` image links. */
  assetBase: string;
}) {
  const { id } = props;
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const syncRef = useRef<BodySync | null>(null);
  const liveMode = useRef(new Compartment());
  const baseConfig = useRef(new Compartment());
  const imageSettings = useRef(props.images);
  imageSettings.current = props.images;
  /** Images being saved: where each link goes, kept up to date as the text changes. */
  const pendingImages = useRef(new Map<string, number>());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** A save that got no answer: the connection is probably gone (see connection.ts). */
  const answerTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const escape = useRef(props.onEscape);
  escape.current = props.onEscape;

  const [loaded, setLoaded] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const conflictRef = useRef<Conflict | null>(null);
  conflictRef.current = conflict;
  const [status, setStatus] = useState<'saved' | 'saving' | 'unsaved' | 'error'>('saved');
  const [notice, setNotice] = useState<string | null>(null);

  // Create the editor once per card.
  useEffect(() => {
    const flush = () => {
      clearTimeout(saveTimer.current);
      const view = viewRef.current;
      const sync = syncRef.current;
      if (!view || !sync || conflictRef.current) return;
      const save = sync.startSave(view.state.doc.toString());
      if (save) {
        setStatus('saving');
        vscode.postMessage({ type: 'saveBody', id, base: save.base, body: save.body });
        clearTimeout(answerTimer.current);
        answerTimer.current = setTimeout(() => {
          // No answer: keep the text as unsaved edits; it's saved again when the connection is back.
          if (!syncRef.current?.saving) return;
          syncRef.current.failed();
          setStatus('error');
          setNotice("Not saved: VS Code isn't answering. Your text stays here and is saved as soon as the connection is back.");
          markDisconnected();
        }, ACK_TIMEOUT_MS);
      }
    };
    const offReconnect = onReconnect(() => {
      if (syncRef.current?.dirty) {
        setNotice(null);
        flush();
      }
    });
    const scheduleSave = () => {
      setStatus('unsaved');
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(flush, SAVE_DELAY_MS);
    };

    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: '',
        extensions: [
          history(),
          search({ top: true }),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          // Lowest precedence, so Escape still closes the search panel first.
          Prec.lowest(keymap.of([{ key: 'Escape', run: () => (escape.current(), true) }])),
          markdown({ base: markdownLanguage }),
          syntaxHighlighting(highlight),
          EditorView.lineWrapping,
          liveMode.current.of(props.live ? livePreview : []),
          baseConfig.current.of(assetBase.of(props.assetBase)),
          EditorState.readOnly.of(false),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              for (const [key, pos] of pendingImages.current) pendingImages.current.set(key, u.changes.mapPos(pos, 1));
            }
            for (const tr of u.transactions) {
              if (tr.docChanged && !tr.annotation(fromHost)) {
                syncRef.current?.userEdit(tr.changes);
                scheduleSave();
              }
            }
          }),
          EditorView.domEventHandlers({
            blur: () => void flush(),
            // Pasting or dropping an image saves it as a file and inserts its link.
            paste: (event, view) => {
              const cd = event.clipboardData;
              const files = imageFiles(cd?.files);
              vscode.postMessage({
                type: 'clientLog',
                message: `paste: types=[${[...(cd?.types ?? [])].join(', ')}] files=${cd?.files.length ?? 0} items=[${[...(cd?.items ?? [])].map((i) => `${i.kind}:${i.type}`).join(', ')}] images=${files.length}`,
              });
              if (files.length === 0) return false;
              event.preventDefault();
              void saveImages(files, view.state.selection.main.head);
              return true;
            },
            drop: (event, view) => {
              const files = imageFiles(event.dataTransfer?.files);
              vscode.postMessage({
                type: 'clientLog',
                message: `drop: types=[${[...(event.dataTransfer?.types ?? [])].join(', ')}] files=${event.dataTransfer?.files.length ?? 0} images=${files.length}`,
              });
              if (files.length === 0) return false;
              event.preventDefault();
              const at = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
              void saveImages(files, at);
              return true;
            },
          }),
        ],
      }),
    });
    viewRef.current = view;

    const applyFromHost = (changes: ChangeSet | null) => {
      if (changes) {
        view.dispatch({ changes, annotations: [fromHost.of(true), Transaction.addToHistory.of(false)] });
      }
    };

    const saveImages = async (files: File[], at: number) => {
      for (const file of files) {
        const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        pendingImages.current.set(requestId, at);
        setNotice('Saving image…');
        try {
          const { ext, data } = await prepareImage(file, imageSettings.current.format, imageSettings.current.maxWidth);
          vscode.postMessage({ type: 'clientLog', message: `image prepared: ${file.type} ${file.size} bytes → ${ext}, ${Math.round((data.length * 3) / 4)} bytes; sending` });
          vscode.postMessage({ type: 'saveImage', requestId, id, ext, data });
        } catch (e) {
          pendingImages.current.delete(requestId);
          setNotice(`The image couldn't be read: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    };

    const off = onHostMessage((m) => {
      if (m.type === 'imageSaved' || m.type === 'imageError') {
        const at = pendingImages.current.get(m.requestId);
        if (at === undefined) return;
        pendingImages.current.delete(m.requestId);
        if (m.type === 'imageError') {
          setNotice(`The image wasn't saved: ${m.message}`);
          return;
        }
        setNotice(null);
        // An ordinary edit: it saves and syncs like typing.
        const pos = Math.min(at, view.state.doc.length);
        const insert = imageInsert(view.state.doc.toString(), pos, m.link);
        view.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos + insert.length } });
        return;
      }
      if (!('id' in m) || m.id !== id) return;
      switch (m.type) {
        case 'editorBody': {
          if (!syncRef.current) {
            // First load: the only time the whole text is set.
            syncRef.current = new BodySync(m.body);
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: m.body },
              // Cursor at the end, so the title shows without its markup until you go there.
              selection: { anchor: m.body.length },
              annotations: [fromHost.of(true), Transaction.addToHistory.of(false)],
            });
            setLoaded(true);
          } else if (conflictRef.current) {
            setConflict({ theirs: m.body });
          } else {
            applyFromHost(syncRef.current.external(m.body));
          }
          break;
        }
        case 'bodySaved': {
          clearTimeout(answerTimer.current);
          const sync = syncRef.current!;
          applyFromHost(sync.saved(m.body));
          if (sync.dirty) scheduleSave();
          else setStatus('saved');
          break;
        }
        case 'bodyConflict':
          clearTimeout(answerTimer.current);
          syncRef.current?.failed();
          setStatus('unsaved');
          setConflict({ theirs: m.theirs });
          break;
        case 'bodyError':
          clearTimeout(answerTimer.current);
          syncRef.current?.failed();
          setStatus('error');
          setNotice(m.message);
          break;
        case 'editorClosed':
          setNotice(m.reason);
          break;
      }
    });

    vscode.postMessage({ type: 'openEditor', id });
    return () => {
      flush();
      off();
      offReconnect();
      clearTimeout(answerTimer.current);
      vscode.postMessage({ type: 'closeEditor' });
      view.destroy();
      viewRef.current = null;
      syncRef.current = null;
    };
    // The editor is created once per card; live mode is switched below without recreating it.
  }, [id]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: liveMode.current.reconfigure(props.live ? livePreview : []) });
  }, [props.live]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: baseConfig.current.reconfigure(assetBase.of(props.assetBase)) });
  }, [props.assetBase]);

  const resolve = (choice: 'mine' | 'theirs') => {
    const view = viewRef.current;
    const sync = syncRef.current;
    if (!view || !sync || !conflict) return;
    const doc = view.state.doc.toString();
    if (choice === 'mine') {
      sync.keepMine(conflict.theirs, doc);
      setConflict(null);
      const save = sync.startSave(doc);
      if (save) {
        setStatus('saving');
        vscode.postMessage({ type: 'saveBody', id, base: save.base, body: save.body });
      }
    } else {
      view.dispatch({ changes: sync.takeTheirs(conflict.theirs, doc), annotations: [fromHost.of(true)] });
      setConflict(null);
      setStatus('saved');
    }
  };

  return (
    <div className="inline-editor">
      {conflict && (
        <div className="conflict" role="alert">
          <span>This card changed while you were editing it, in the same place. Nothing was saved yet.</span>
          <div className="conflict-actions">
            <button type="button" onClick={() => resolve('mine')}>
              Keep mine
            </button>
            <button type="button" onClick={() => resolve('theirs')}>
              Take theirs
            </button>
            <button
              type="button"
              onClick={() => vscode.postMessage({ type: 'showDiff', id, mine: viewRef.current?.state.doc.toString() ?? '' })}
            >
              Show diff
            </button>
          </div>
        </div>
      )}
      {notice && (
        <div className="notice" role="status">
          {notice}
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      )}
      <div className={`cm-host ${loaded ? '' : 'loading'}`} ref={host} />
      <div className={`save-status save-${status}`}>
        {status === 'saved' ? 'Saved' : status === 'saving' ? 'Saving…' : status === 'unsaved' ? 'Unsaved' : 'Not saved'}
      </div>
    </div>
  );
}
