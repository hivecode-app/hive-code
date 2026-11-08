import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkAuthority } from '../src/index.ts';

const bash = (command: string) => checkAuthority({ tool_name: 'Bash', tool_input: { command } }, '/home/u');

test('#480: the five classes are refused', () => {
  for (const c of [
    'rm -rf /', 'rm -rf ~', 'rm -rf ~/', 'rm -fr $HOME', 'rm -rf "$HOME"', 'rm -r -f /home', 'sudo rm -rf /etc',
    'rm -rf /usr/', 'rm -rf /var/*', 'rm -rf /boot', 'rm --recursive --force /', 'cd /tmp && rm -rf /',
    'echo x; rm -rf ~ ', 'rm -rf /tmp/x ~',
    'mkfs.ext4 /dev/sdb1', 'sudo mkfs -t ext4 /dev/sdb', 'dd if=/dev/zero of=/dev/sda bs=1M', 'dd if=x.img of=/dev/nvme0n1',
    ':(){ :|:& };:',
    'shutdown -h now', 'sudo reboot', 'poweroff', 'halt', 'systemctl poweroff', 'sudo systemctl reboot', 'ls && /sbin/shutdown now',
    // The review of #504: a full home path, wrappers, flags after the target, a shell's -c, a raw redirect.
    'rm -rf /home/u', 'rm -rf /home/ran/', 'rm -rf /home/ran/*', 'sudo -u root rm -rf /', 'timeout 5 reboot', 'time rm -rf ~',
    'nice rm -rf /', 'xargs rm -rf ~', "bash -c 'rm -rf ~'", 'rm ~ -rf', '\\rm -rf ~', 'cat x > /dev/sda', 'dd of=/dev/mapper/root',
    'echo "$(rm -rf ~)"', 'X=1 env Y=2 rm -rf /', 'init 0', '{ reboot; }',
  ]) assert.match(bash(c) ?? '', /^Permission authority refused this: /, c);
});

test('#480: ordinary commands that mention the words pass', () => {
  for (const c of [
    'rm -rf ~/projects/x', 'rm -rf /tmp/build', 'rm -rf "$HOME/.cache/x"', 'rm -f ~', 'rm -rf ./node_modules', 'rm -rf dist/',
    'git commit -m "fix reboot loop"', 'grep -rn shutdown src/', 'echo "halt and catch fire"', 'node scripts/x.mjs --no-reboot',
    'dd if=/dev/zero of=/tmp/disk.img bs=1M count=10', 'mkdir -p /tmp/mkfs-test', 'systemctl --user restart agent-company-hq',
    'cat /etc/hosts', 'ls /home',
    // The review of #504: quotes, patterns and heredoc bodies are text, not commands.
    'journalctl -b | grep -E "(reboot|shutdown)"', "grep -E 'error|halt|panic' log", 'echo "(halt and catch fire)"',
    "awk '{ halt = 1 }' f", "git commit -m \"$(cat <<'EOF'\nreboot handling: retry\nrm -rf / is refused\nEOF\n)\"",
    "cat > docs/a.md <<'EOF'\nrm -rf / is refused\nshutdown now\nEOF", 'rm -rf /home/u/projects/x', 'rm -rf /var/tmp/x',
    'systemctl --user status reboot-guard', 'cat /dev/sda1 > /tmp/img',
  ]) assert.equal(bash(c), null, c);
  assert.equal(checkAuthority({ tool_name: 'Write', tool_input: { file_path: '/', content: 'rm -rf /' } }), null);
});

test('#480: the hook CLI denies in PreToolUse, under bypassPermissions too', async () => {
  const state = mkdtempSync(join(tmpdir(), 'auth-'));
  const out = await new Promise<string>((res) => {
    const p = spawn(process.execPath, [join(import.meta.dirname, '../src/cli.ts'), 'hook', 'PreToolUse'], {
      env: { ...process.env, COMPANY_STATE_DIR: state, AGENT_COMPANY_STATE: state, COMPANY_REPO: '/nonexistent/.worktrees/x' },
    });
    let o = ''; p.stdout.on('data', (d) => { o += d; }); p.on('close', () => res(o));
    p.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf ~' }, cwd: '/tmp', permission_mode: 'bypassPermissions' }));
  });
  const j = JSON.parse(out) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  assert.equal(j.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(j.hookSpecificOutput.permissionDecisionReason, /recursive delete/);
});
