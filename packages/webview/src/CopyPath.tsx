import { useState } from 'react';
import { vscode } from './vscode.js';

/**
 * Copies the card's path (as an @mention by default) to paste into an agent's
 * chat. Cards are buttons themselves, so this is a focusable span that keeps
 * its click from opening the card.
 */
export function CopyPath({ path, label }: { path: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = (e: React.SyntheticEvent) => {
    e.stopPropagation();
    e.preventDefault();
    vscode.postMessage({ type: 'copyPath', path });
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <span
      role="button"
      tabIndex={0}
      className={`copy-path ${copied ? 'copied' : ''} ${label ? 'with-label' : ''}`}
      title={copied ? 'Copied' : 'Copy the card\'s path, to paste into an agent\'s chat'}
      aria-label="Copy card path"
      onClick={copy}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') copy(e);
      }}
    >
      {copied ? '✓' : (
        <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
          <rect x="5" y="5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      )}
      {label && <span>{copied ? 'Copied' : label}</span>}
    </span>
  );
}
