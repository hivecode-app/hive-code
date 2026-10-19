// injectForeign: deliver a message into a session we do NOT hold (B.4 row 2),
// via the native cross-session socket (research/05 §3.5, experiment 4d).
// Without the <cross-session-message ... from-mode="bypass"> envelope the
// message is held and dropped. Read-only on ~/.claude/sessions.
import { readFileSync, readdirSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { procStartOf } from './claude-process.ts';
import { newUuid } from './ids.ts';
import type { Priority } from '@company/shared';

export interface LiveSession {
  pid: number;
  sessionId: string;
  cwd: string;
  procStart?: string;
  messagingSocketPath?: string;
  name?: string;
  status?: string;
  version?: string;
  kind?: string;
}

export function sessionsDir(configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')): string {
  return join(configDir, 'sessions');
}

export function readLiveSession(pid: number, dir = sessionsDir()): LiveSession | null {
  try { return JSON.parse(readFileSync(join(dir, `${pid}.json`), 'utf8')) as LiveSession; } catch { return null; }
}

export function listLiveSessions(dir = sessionsDir()): LiveSession[] {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return []; }
  const out: LiveSession[] = [];
  for (const n of names) {
    const m = /^(\d+)\.json$/.exec(n);
    if (!m) continue;
    const s = readLiveSession(Number(m[1]), dir);
    if (s && (!s.procStart || procStartOf(s.pid) === s.procStart)) out.push(s);
  }
  return out;
}

function peerToken(pid: number, dir: string): string | null {
  try {
    const f = readdirSync(dir).find((n) => n.startsWith(`${pid}.`) && n.endsWith('.key'));
    if (!f) return null;
    return (JSON.parse(readFileSync(join(dir, f), 'utf8')) as { peerToken?: string }).peerToken ?? null;
  } catch { return null; }
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export function envelope(body: string, fromName: string, fromAddr = `uds:/tmp/cc-socks/${process.pid}.sock`): string {
  return `<cross-session-message from="${esc(fromAddr)}" from-name="${esc(fromName)}" from-mode="bypass">\n${body}\n</cross-session-message>`;
}

export interface InjectOptions {
  fromName?: string;
  priority?: Priority;
  sessionsDir?: string;
  /** Override socket path (tests). */
  socketPath?: string;
  timeoutMs?: number;
}

/** Writes one envelope message. Resolves when the bytes are flushed; the socket
 *  never answers (status arrives, if ever, through the receiver's own events). */
export async function injectForeign(pid: number, body: string, o: InjectOptions = {}): Promise<{ uuid: string; socketPath: string }> {
  const dir = o.sessionsDir ?? sessionsDir();
  let socketPath = o.socketPath;
  if (!socketPath) {
    const s = readLiveSession(pid, dir);
    if (!s) throw new Error(`no live session for pid ${pid}`);
    if (s.procStart && procStartOf(pid) !== s.procStart) throw new Error(`pid ${pid} was reused`);
    socketPath = s.messagingSocketPath ?? `/tmp/cc-socks/${pid}.sock`;
  }
  const uuid = newUuid();
  const token = o.socketPath ? null : peerToken(pid, dir);
  const lines: string[] = [];
  if (token) lines.push(JSON.stringify({ type: 'auth', token }));
  lines.push(JSON.stringify({
    type: 'user', uuid, priority: o.priority ?? 'next',
    message: { role: 'user', content: envelope(body, o.fromName ?? 'company') },
  }));
  await new Promise<void>((resolve, reject) => {
    const sock = createConnection(socketPath!);
    const t = setTimeout(() => { sock.destroy(); reject(new Error('socket timeout')); }, o.timeoutMs ?? 5000);
    sock.on('error', (e) => { clearTimeout(t); reject(e); });
    sock.on('connect', () => {
      sock.end(lines.join('\n') + '\n', () => { clearTimeout(t); resolve(); });
    });
  });
  return { uuid, socketPath };
}
