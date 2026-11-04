import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Store } from './store.ts';
import { UploadError } from './uploads.ts';

const within = (path: string, dir: string) => path === dir || path.startsWith(dir + sep);

/** Resolve first: hq copies only what belongs to this task or the message it is answering. */
export function workerPath(store: Store, stateDir: string, identity: string, input: string, ref?: string): string {
  if (!isAbsolute(input)) throw new UploadError(400, 'file path must be absolute');
  let path: string;
  try { path = realpathSync(input); } catch { throw new UploadError(400, `file does not exist: ${input}`); }
  const denied = [stateDir, resolve(homedir(), '.config'), resolve(homedir(), '.claude'), resolve(homedir(), '.ssh'), '/srv/browser-work']
    .map((p) => { try { return realpathSync(p); } catch { return resolve(p); } });
  // Only the actual attachments of the referenced incoming message, never all state/uploads.
  const incoming = ref ? store.db.prepare('SELECT attachments FROM messages WHERE id = ? AND to_identity = ?').get(ref, identity) as { attachments: string | null } | undefined : undefined;
  const files = incoming?.attachments ? JSON.parse(incoming.attachments) as { id: string }[] : [];
  const attachment = files.some(({ id }) => {
    const row = store.db.prepare('SELECT path FROM uploads WHERE id = ?').get(id) as { path: string } | undefined;
    return row && (path === row.path || within(path, `${row.path}.d`));
  });
  if (attachment) return path;
  if (denied.some((dir) => within(path, dir))) throw new UploadError(403, 'file is outside the allowed task paths');
  const tasks = store.db.prepare("SELECT worktree FROM tasks WHERE identity = ? AND state IN ('running','resting') AND worktree IS NOT NULL").all(identity) as { worktree: string }[];
  const roots = ['/tmp', ...tasks.map((t) => t.worktree)].map((p) => { try { return realpathSync(p); } catch { return resolve(p); } });
  if (!roots.some((dir) => within(path, dir))) throw new UploadError(403, 'file is outside the allowed task paths');
  if (!statSync(path).isFile() && !statSync(path).isDirectory()) throw new UploadError(400, 'path must be a regular file or directory');
  return path;
}
