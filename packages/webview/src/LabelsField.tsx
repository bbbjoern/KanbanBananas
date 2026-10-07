import { useEffect, useId, useRef, useState } from 'react';
import { addLabels, labelToAdd, suggestLabels } from './labels.js';

/**
 * A card's labels as chips, with an input that suggests the board's existing
 * labels while typing. Enter, Tab or a comma adds; a label already on the card
 * isn't added twice, and one that exists with other capitals keeps the board's
 * spelling. Every change is saved straight away.
 */
export function LabelsField(props: { labels: string[]; known: string[]; onChange: (labels: string[]) => void }) {
  const [labels, setLabels] = useState(props.labels);
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [hint, setHint] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  // Follow the card (the host's copy wins), but only when its labels really changed.
  const joined = props.labels.join('\n');
  useEffect(() => setLabels(joined ? joined.split('\n') : []), [joined]);

  const suggestions = open ? suggestLabels(draft, labels, props.known) : [];
  const typedNew = draft.trim() && !props.known.some((l) => l.toLowerCase() === draft.trim().toLowerCase()) ? draft.trim() : null;
  // The list: matching labels, then "Add new label" for text that matches none.
  const options = [...suggestions, ...(typedNew && labelToAdd(typedNew, labels, props.known) ? [typedNew] : [])];
  const activeIndex = Math.min(active, options.length - 1);

  const save = (next: string[]) => {
    setLabels(next);
    props.onChange(next);
  };
  const add = (typed: string[]) => {
    const next = addLabels(typed, labels, props.known);
    const dupe = typed.find((t) => t.trim() && !labelToAdd(t, labels, props.known));
    const onCard = dupe && labels.find((l) => l.toLowerCase() === dupe.trim().replace(/\s+/g, ' ').toLowerCase());
    setHint(onCard ? `“${onCard}” is already on this card.` : null);
    setDraft('');
    setActive(0);
    setOpen(false); // reopens on typing, so a second Enter doesn't add a label by accident
    if (next.length !== labels.length) save(next);
  };
  const remove = (label: string) => {
    save(labels.filter((l) => l !== label));
    input.current?.focus();
  };

  return (
    <div className="labels-field wide">
      <span id={`${listId}-label`}>Labels</span>
      <div
        className="labels-box"
        onMouseDown={(e) => {
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          input.current?.focus();
        }}
      >
        {labels.map((l) => (
          <span key={l} className="label chip">
            {l}
            <button type="button" aria-label={`Remove label ${l}`} title="Remove" onClick={() => remove(l)}>
              ×
            </button>
          </span>
        ))}
        <input
          ref={input}
          value={draft}
          placeholder={labels.length ? '' : 'Add labels'}
          role="combobox"
          aria-labelledby={`${listId}-label`}
          aria-expanded={open && options.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && options.length ? `${listId}-${activeIndex}` : undefined}
          onBlur={() => {
            if (draft.trim()) add([draft]);
            setOpen(false);
            setHint(null);
          }}
          onChange={(e) => {
            const v = e.target.value;
            setOpen(true);
            setActive(0);
            setHint(null);
            if (!v.includes(',')) return setDraft(v);
            // A comma ends a label; pasting "a, b, c" adds them all.
            const parts = v.split(',');
            add(parts.slice(0, -1));
            setDraft(parts.at(-1)!.trimStart());
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setOpen(true);
              if (options.length) setActive((activeIndex + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
            } else if (e.key === 'Enter' || (e.key === 'Tab' && draft.trim())) {
              const pick = open ? options[activeIndex] : undefined;
              if (!pick && !draft.trim()) return;
              e.preventDefault();
              add([pick ?? draft]);
            } else if (e.key === 'Backspace' && !draft && labels.length) {
              save(labels.slice(0, -1));
            } else if (e.key === 'Escape' && (draft || (open && options.length))) {
              e.stopPropagation(); // clear the input first; the next Escape closes the card
              setDraft('');
              setOpen(false);
            }
          }}
        />
      </div>
      {open && options.length > 0 && (
        <ul className="label-suggestions" id={listId} role="listbox">
          {options.map((o, i) => (
            <li
              key={o}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              className={i === activeIndex ? 'active' : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => add([o])}
            >
              {i >= suggestions.length ? (
                <>
                  Add new label <strong>{o}</strong>
                </>
              ) : (
                o
              )}
            </li>
          ))}
        </ul>
      )}
      {hint && <span className="labels-hint">{hint}</span>}
    </div>
  );
}
