import { describe, expect, it } from 'vitest';
import { checkHello, HUB_PROTOCOL_VERSION, normalizeRemote, protocolRefusal, sameRepo, type HelloMessage } from '../src/index.js';

const hello = (over: Partial<HelloMessage> = {}): HelloMessage => ({
  type: 'hello',
  protocol: HUB_PROTOCOL_VERSION,
  client: { kind: 'extension', version: '1.7.0' },
  repo: { remote: 'git@github.com:bbbjoern/KanbanBananas.git', featuresDir: '.devtool/features' },
  columns: [],
  cards: [],
  ...over,
});

describe('normalizeRemote', () => {
  it('spells every form of the same GitHub remote the same way', () => {
    const want = 'github.com/bbbjoern/KanbanBananas';
    expect(normalizeRemote('git@github.com:bbbjoern/KanbanBananas.git')).toBe(want);
    expect(normalizeRemote('https://github.com/bbbjoern/KanbanBananas.git')).toBe(want);
    expect(normalizeRemote('https://github.com/bbbjoern/KanbanBananas')).toBe(want);
    expect(normalizeRemote('https://github.com/bbbjoern/KanbanBananas/')).toBe(want);
    expect(normalizeRemote('https://bbbjoern@github.com/bbbjoern/KanbanBananas.git')).toBe(want);
    expect(normalizeRemote('ssh://git@github.com/bbbjoern/KanbanBananas.git')).toBe(want);
    expect(normalizeRemote('ssh://git@github.com:22/bbbjoern/KanbanBananas.git')).toBe(want);
    expect(normalizeRemote('  git@GitHub.com:bbbjoern/KanbanBananas.git\n')).toBe(want);
  });

  it('lower-cases only the host', () => {
    expect(normalizeRemote('git@Example.ORG:Owner/Name.git')).toBe('example.org/Owner/Name');
  });

  it('keeps a local path, a Windows path and an empty string as they are', () => {
    expect(normalizeRemote('/home/bjoern/repo')).toBe('/home/bjoern/repo');
    expect(normalizeRemote('../other/repo.git')).toBe('../other/repo.git');
    expect(normalizeRemote('C:\\src\\repo')).toBe('C:\\src\\repo');
    expect(normalizeRemote('')).toBe('');
  });
});

describe('sameRepo', () => {
  it('ignores the remote spelling and the slashes around the features directory', () => {
    const a = { remote: 'git@github.com:o/n.git', featuresDir: '.devtool/features' };
    expect(sameRepo(a, { remote: 'https://github.com/o/n', featuresDir: './.devtool/features/' })).toBe(true);
    expect(sameRepo(a, { remote: 'https://github.com/o/n', featuresDir: '.devtool\\features' })).toBe(true);
  });

  it('is false for another repo or another features directory', () => {
    const a = { remote: 'git@github.com:o/n.git', featuresDir: '.devtool/features' };
    expect(sameRepo(a, { remote: 'git@github.com:o/other.git', featuresDir: '.devtool/features' })).toBe(false);
    expect(sameRepo(a, { remote: 'git@github.com:o/n.git', featuresDir: 'docs/cards' })).toBe(false);
  });
});

describe('protocolRefusal', () => {
  const who = { them: 'the extension', us: 'the hub' };

  it('is null when the versions match', () => {
    expect(protocolRefusal(1, 1, who)).toBeNull();
  });

  it('names the side that is behind', () => {
    expect(protocolRefusal(1, 2, who)).toMatchObject({ type: 'refused', code: 'protocol', protocol: 2, message: "Hub protocol 1 doesn't match 2: update the extension." });
    expect(protocolRefusal(3, 2, who)).toMatchObject({ code: 'protocol', protocol: 2, message: "Hub protocol 3 doesn't match 2: update the hub." });
  });
});

describe('checkHello', () => {
  it('lets a matching client in, bound to a repo or not', () => {
    expect(checkHello(hello(), null)).toBeNull();
    expect(checkHello(hello(), { remote: 'https://github.com/bbbjoern/KanbanBananas', featuresDir: './.devtool/features' })).toBeNull();
  });

  it('refuses another protocol version, naming the client', () => {
    const refused = checkHello(hello({ protocol: HUB_PROTOCOL_VERSION + 1 }), null);
    expect(refused).toMatchObject({ code: 'protocol', protocol: HUB_PROTOCOL_VERSION });
    expect(refused?.message).toContain('update the hub');
    const old = checkHello(hello({ protocol: 0, client: { kind: 'cli', version: '1.6.1' } }), null);
    expect(old?.message).toBe(`Hub protocol 0 doesn't match ${HUB_PROTOCOL_VERSION}: update the cli (1.6.1).`);
  });

  it('refuses a client that speaks for another repo than the token is bound to', () => {
    const refused = checkHello(hello(), { remote: 'git@github.com:bbbjoern/SuperTask.git', featuresDir: '.devtool/features' });
    expect(refused).toMatchObject({ type: 'refused', code: 'repo', protocol: HUB_PROTOCOL_VERSION });
    expect(refused?.message).toBe('This token is for github.com/bbbjoern/SuperTask (.devtool/features), not github.com/bbbjoern/KanbanBananas (.devtool/features).');
  });

  it('checks the protocol before the repo', () => {
    expect(checkHello(hello({ protocol: 99 }), { remote: 'x', featuresDir: 'y' })?.code).toBe('protocol');
  });
});
