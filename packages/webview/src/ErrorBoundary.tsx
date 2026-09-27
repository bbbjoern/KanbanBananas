import { Component, type ErrorInfo, type ReactNode } from 'react';
import { vscode } from './vscode.js';

/** Report an error to the extension's log. */
export function reportClientError(error: unknown, extra?: string): void {
  const e = error instanceof Error ? error : new Error(String(error));
  vscode.postMessage({ type: 'clientError', message: e.message, stack: [e.stack, extra].filter(Boolean).join('\n') });
}

/** Instead of a blank page, show what broke and offer a reload. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    reportClientError(error, info.componentStack ?? undefined);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="message error crash">
        <p>
          <strong>The board hit an error:</strong> {this.state.error.message}
        </p>
        <p>The details are in the KanbanBananas log (Output panel). Your cards weren't changed by this.</p>
        <button type="button" className="tool" onClick={() => this.setState({ error: null })}>
          Reload
        </button>
      </div>
    );
  }
}
