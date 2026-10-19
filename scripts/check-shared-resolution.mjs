#!/usr/bin/env node
// pretest: @company/shared must resolve to this checkout's packages/shared.
// In a worktree under .worktrees/ without its own `npm install`, Node walks up
// to the main checkout's node_modules and silently tests against old code.
// Usage: node scripts/check-shared-resolution.mjs   (runs as `npm test`'s pretest)

import { realpathSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const expected = realpathSync(join(root, 'packages', 'shared'));

let resolved;
let reason = '';
try {
  resolved = realpathSync(fileURLToPath(import.meta.resolve('@company/shared')));
} catch (e) {
  resolved = null;
  reason = ` (${e.message})`;
}

if (resolved === null || !resolved.startsWith(expected + sep)) {
  console.error(
    `\n@company/shared ${resolved ? `נפתר מחוץ ל-repo הנוכחי:\n  ${resolved}` : `לא נמצא${reason}`}\n` +
      `ציפיתי לנתיב בתוך:\n  ${expected}\n\n` +
      `הרץ npm install ב-worktree:\n  cd ${root} && npm install\n`,
  );
  process.exit(1);
}
