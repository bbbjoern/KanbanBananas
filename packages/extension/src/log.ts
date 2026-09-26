import * as vscode from 'vscode';

/** The "KanbanBananas" channel in the Output panel. Created in activate(). */
export let log: vscode.LogOutputChannel = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
} as unknown as vscode.LogOutputChannel;

export function createLog(): vscode.LogOutputChannel {
  log = vscode.window.createOutputChannel('KanbanBananas', { log: true });
  return log;
}

/** Log an error and tell the user; for failures that would otherwise vanish. */
export function reportError(what: string, e: unknown): void {
  const message = e instanceof Error ? e.message : String(e);
  log.error(`${what}: ${message}`);
  void vscode.window.showErrorMessage(`KanbanBananas: ${what}: ${message}`, 'Show Log').then((choice) => {
    if (choice === 'Show Log') log.show();
  });
}
