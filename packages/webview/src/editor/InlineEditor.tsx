import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import { Annotation, Compartment, EditorState, Prec, Transaction, type ChangeSet } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { useEffect, useRef, useState } from 'react';
import { BodySync } from '../bodySync.js';
import { onHostMessage, vscode } from '../vscode.js';
import { livePreview } from './livePreview.js';

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
export function InlineEditor(props: { id: string; live: boolean; onEscape: () => void }) {
  const { id } = props;
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const syncRef = useRef<BodySync | null>(null);
  const liveMode = useRef(new Compartment());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
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
      }
    };
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
          EditorState.readOnly.of(false),
          EditorView.updateListener.of((u) => {
            for (const tr of u.transactions) {
              if (tr.docChanged && !tr.annotation(fromHost)) {
                syncRef.current?.userEdit(tr.changes);
                scheduleSave();
              }
            }
          }),
          EditorView.domEventHandlers({ blur: () => void flush() }),
        ],
      }),
    });
    viewRef.current = view;

    const applyFromHost = (changes: ChangeSet | null) => {
      if (changes) {
        view.dispatch({ changes, annotations: [fromHost.of(true), Transaction.addToHistory.of(false)] });
      }
    };

    const off = onHostMessage((m) => {
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
          const sync = syncRef.current!;
          applyFromHost(sync.saved(m.body));
          if (sync.dirty) scheduleSave();
          else setStatus('saved');
          break;
        }
        case 'bodyConflict':
          syncRef.current?.failed();
          setStatus('unsaved');
          setConflict({ theirs: m.theirs });
          break;
        case 'bodyError':
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
