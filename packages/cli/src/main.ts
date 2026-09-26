import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAgentMovePolicy, SKILL_POLICY_FILE, type SkillPolicy } from '@kanban-bananas/core';
import { run } from './cli.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Installed as <skill>/scripts/kanban.mjs; the extension writes <skill>/policy.json from the user's settings. */
function readSkillPolicy(): SkillPolicy | undefined {
  try {
    const path = join(dirname(fileURLToPath(import.meta.url)), '..', SKILL_POLICY_FILE);
    const policy = JSON.parse(readFileSync(path, 'utf8')) as Partial<SkillPolicy>;
    return isAgentMovePolicy(policy.agentsMayMoveCards) ? { agentsMayMoveCards: policy.agentsMayMoveCards } : undefined;
  } catch {
    return undefined;
  }
}

const skillPolicy = readSkillPolicy();
process.exitCode = await run(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  readStdin,
  ...(skillPolicy ? { skillPolicy } : {}),
});
