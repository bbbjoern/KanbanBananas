import { DONE_STATUS } from './validate.js';

/**
 * How far agents may move cards, chosen in the `kanbanBananas.agentsMayMoveCards`
 * setting. The installed skill is written to match it, and the CLI enforces it
 * from `policy.json` in the skill folder (`--force` overrides, on the user's say-so).
 */
export const AGENT_MOVE_POLICIES = ['never', 'notToDone', 'anywhere'] as const;
export type AgentMovePolicy = (typeof AGENT_MOVE_POLICIES)[number];
export const DEFAULT_AGENT_MOVE_POLICY: AgentMovePolicy = 'notToDone';

/** Written next to SKILL.md by the extension; read by the bundled CLI. */
export const SKILL_POLICY_FILE = 'policy.json';

export interface SkillPolicy {
  agentsMayMoveCards: AgentMovePolicy;
  /** The board's column ids, in order, so the CLI accepts the project's own columns. */
  statuses?: string[];
  /** The columns' names on the board, by status, so agents can use the name the user says. */
  columnNames?: Record<string, string>;
  /** Present when session memory is on: its file (relative to the project root) and how many entries to keep. */
  sessionMemory?: { file: string; keep: number };
}

export function isAgentMovePolicy(v: unknown): v is AgentMovePolicy {
  return (AGENT_MOVE_POLICIES as readonly unknown[]).includes(v);
}

/** Why the policy refuses this, or null if it's allowed. */
export function policyRefusal(policy: AgentMovePolicy, action: 'move' | 'create', status: string): string | null {
  if (policy === 'never' && action === 'move') {
    return 'The user moves cards between columns themselves (agentsMayMoveCards: never).';
  }
  if (policy !== 'anywhere' && status === DONE_STATUS) {
    return 'Only the user puts cards in done' + (policy === 'never' ? ' (agentsMayMoveCards: never).' : ' (agentsMayMoveCards: notToDone).');
  }
  return null;
}

/** The parts of SKILL.md that depend on the policy. `kanban` is the command path. */
export function skillPolicyText(policy: AgentMovePolicy, kanban: string): Record<'MOVE_RULE' | 'START_WORK' | 'AFTER_NOTE', string> {
  const find = '```sh\n' + `${kanban} find <id or topic>` + '\n```';
  switch (policy) {
    case 'never':
      return {
        MOVE_RULE:
          "**Don't move cards between columns.** The user does that themselves. `move` is refused; only if the user explicitly asks you to move a specific card, run it with `--force`.",
        START_WORK: `${find}\n\nDon't move it to \`in-progress\`; the user does that.`,
        AFTER_NOTE: 'Leave the card in its column. The user reviews it and moves it.',
      };
    case 'notToDone':
      return {
        MOVE_RULE:
          '**Never move a card to `done`.** Only the user does that. You may move cards between the other columns.',
        START_WORK: '```sh\n' + `${kanban} find <id or topic>\n${kanban} move <id> in-progress` + '\n```',
        AFTER_NOTE: 'Then move it to `review` so the user can check it. Never to `done`.',
      };
    case 'anywhere':
      return {
        MOVE_RULE: '**You may move cards between any columns**, including `done` once the work is finished and checked.',
        START_WORK: '```sh\n' + `${kanban} find <id or topic>\n${kanban} move <id> in-progress` + '\n```',
        AFTER_NOTE: 'Then move it to `review` if the user should look at it, or to `done` if the work is complete and verified.',
      };
  }
}
