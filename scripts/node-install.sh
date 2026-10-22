#!/usr/bin/env bash
# Set up (or update) a node: another machine that takes task shifts over ssh (packages/hq/src/nodes.ts).
#   scripts/node-install.sh <node>            full setup, idempotent: tools, checkouts, claude, gh, the shift unit
#   scripts/node-install.sh <node> --update   the engine there to this checkout's commit (scripts/deploy.sh hq runs it)
#   scripts/node-install.sh <node> --token <file>   the node's Claude token (claude setup-token), to its own file there
#   scripts/node-install.sh <node> --projects  only the toolchains and the projects' checkouts (after adding a project)
# <node> is a name in hq.config.json `nodes`. The node mirrors this machine's paths: $HOME is /home/owner there too (a
# directory, not a user: the shifts run as the node's existing user, root when there is no other), so worktrees,
# sockets and shift dirs are the same paths on both sides. Nothing there is touched beyond those paths, /usr/local
# (node, gh), and /etc/systemd/system/company-shift@.service. Never this machine's ~/.claude (dir-0016).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/.." && pwd)"
name="${1:?usage: node-install.sh <node> [--update | --token <file>]}"
mode="${2:-install}"
STATE="${AGENT_COMPANY_STATE:-$HOME/.local/state/agent-company}"
CONFIG="$STATE/hq.config.json"
[[ -f "$CONFIG" ]] || CONFIG="${HQ_CONFIG_SRC:-$HOME/company/company/hq.config.json}"

read -r ssh_target ssh_key projects mirror < <(node -e '
  const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const n = (c.nodes || []).find((x) => x.name === process.argv[2]);
  if (!n) { console.error(`no node ${process.argv[2]} in ${process.argv[1]}`); process.exit(1); }
  console.log(n.ssh, n.identityFile || "-", (n.projects || []).join(",") || "-", (n.mirror || []).join(",") || "-");' "$CONFIG" "$name")
[[ "$projects" == "-" ]] && projects=""
[[ "$mirror" == "-" ]] && mirror=""
ssh_args=(-o BatchMode=yes -o ConnectTimeout=15)
[[ "$ssh_key" != "-" ]] && ssh_args+=(-i "${ssh_key/#\~/$HOME}")
H=/home/owner
NSTATE="$H/.local/state/agent-company"
ENGINE="$H/projects/agent-company"
on() { ssh "${ssh_args[@]}" "$ssh_target" "export HOME=$H PATH=/usr/local/bin:\$PATH; $1"; }
say() { echo "• $name: $*"; }

if [[ "$mode" == "--token" ]]; then
  file="${3:?--token <file>}"
  on "install -d -m700 $NSTATE && umask 077 && cat > $NSTATE/node-oauth-token.tmp && mv -f $NSTATE/node-oauth-token.tmp $NSTATE/node-oauth-token" <"$file"
  say "הטוקן נכתב ל-$NSTATE/node-oauth-token (600)"
  exit 0
fi

sha="$(git -C "$repo" rev-parse HEAD)"
pinned="$(sed -n "s/^export const PINNED_VERSION = '\(.*\)';/\1/p" "$repo/packages/adapter/src/binary.ts")"
current="$(readlink "$HOME/.local/share/agent-company/claude/current" 2>/dev/null || echo "$pinned")"

# The engine there at this commit; npm ci only when the lock changed.
update_engine() {
  on "set -e; cd $ENGINE; git fetch --quiet origin; before=\$(git rev-parse HEAD); git checkout --quiet --detach $sha
      if [ ! -d node_modules ] || ! git diff --quiet \$before $sha -- package-lock.json; then npm ci --no-audit --no-fund >/dev/null; fi"
  # `company-run` (reserve, resources-design.md): on the PATH of a shift here, which is /usr/local/bin and not ~/.local/bin.
  on "ln -sfn $ENGINE/scripts/company-run /usr/local/bin/company-run"
  # The pinned Claude Code, same version as here.
  on "set -e; [ -x $H/.local/share/agent-company/claude/$current/claude ] || bash $ENGINE/scripts/install-claude.sh $current >/dev/null
      ln -sfn $current $H/.local/share/agent-company/claude/current"
  say "המנוע על ${sha:0:7}, claude $current"
}

if [[ "$mode" == "--update" ]]; then update_engine; exit 0; fi
[[ "$mode" == "install" || "$mode" == "--projects" ]] || { echo "unknown mode $mode" >&2; exit 2; }

# ── tools: git, build tools (better-sqlite3), node (this machine's version, when there is none), gh, and what the
#    projects' setup and tests use (jq, unzip, docker) ──
nodever="$(node -v)"
on "set -e; export DEBIAN_FRONTEND=noninteractive
    command -v git >/dev/null && command -v make >/dev/null && command -v g++ >/dev/null && command -v jq >/dev/null && command -v unzip >/dev/null \
      || { apt-get update -qq; apt-get install -y -qq git build-essential python3 xz-utils curl jq unzip >/dev/null; }
    command -v node >/dev/null || curl -fsSL https://nodejs.org/dist/$nodever/node-$nodever-linux-x64.tar.xz | tar -xJ -C /usr/local --strip-components=1
    command -v gh >/dev/null || apt-get install -y -qq gh >/dev/null
    command -v docker >/dev/null || apt-get install -y -qq docker.io >/dev/null"
say "git, build-essential, jq, unzip, docker, node $nodever, gh"

# ── toolchains: the same Go and Flutter as here, at the same paths (the charters' commands name them) ──
if [[ -x /usr/local/go/bin/go ]]; then
  gover="$(/usr/local/go/bin/go env GOVERSION)"
  on "/usr/local/go/bin/go env GOVERSION 2>/dev/null | grep -qx $gover || { curl -fsSL https://go.dev/dl/$gover.linux-amd64.tar.gz -o /tmp/go.tgz && rm -rf /usr/local/go && tar -C /usr/local -xzf /tmp/go.tgz && rm /tmp/go.tgz; }"
  say "go $gover"
fi
if [[ -x "$HOME/flutter/bin/flutter" ]]; then
  fver="$(git -C "$HOME/flutter" describe --tags --exact-match 2>/dev/null || git -C "$HOME/flutter" rev-parse HEAD)"
  on "set -e; [ -d $H/flutter/.git ] || git clone --quiet --depth 1 -b $fver https://github.com/flutter/flutter.git $H/flutter
      [ \"\$(git -C $H/flutter describe --tags --exact-match 2>/dev/null)\" = $fver ] || { git -C $H/flutter fetch --quiet --depth 1 origin tag $fver && git -C $H/flutter checkout --quiet $fver; }
      $H/flutter/bin/flutter --version >/dev/null 2>&1" </dev/null
  say "flutter $fver"
fi

# ── dirs, git identity and GitHub (this machine's gh token: workers push and open PRs there) ──
on "install -d -m700 $H $H/projects $H/.claude $H/.claude/hooks $H/.local/state $NSTATE $NSTATE/shifts"
on "git config --global user.name $(printf %q "$(git config --global user.name)") && git config --global user.email $(printf %q "$(git config --global user.email)")"
gh auth token | on "gh auth login --with-token && gh auth setup-git"
say "git ו-gh מחוברים כמו כאן"

# ── the checkouts: the engine, the company (COMPANY_HOME), and those of every project the node takes ──
clone() { # <owner/name> <path> [branch or commit]; stdin closed: inside `while read` ssh would eat the loop's input
  # Only a fresh clone goes to the branch or commit: one that is there already is left as it is (the engine there is
  # detached on the deployed commit, and a worker's checkout may be anywhere).
  local to="${3:-}"
  on "set -e; if [ ! -d $2/.git ]; then git clone --quiet https://github.com/$1 $2
        [ -z '$to' ] || git -C $2 checkout --quiet '$to' || echo 'node-install: $2 not at $to (missing in origin?)' >&2; fi" </dev/null
}
# A repo as it is here: its origin, and its branch (or commit, when detached).
slug() { git -C "$1" remote get-url origin 2>/dev/null | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##'; }
at() { local b; b="$(git -C "$1" rev-parse --abbrev-ref HEAD)"; [[ "$b" == HEAD ]] && git -C "$1" rev-parse HEAD || echo "$b"; }
# Repos inside a checkout that git there does not track (lumo's server/ and reference/*): the same, at the same path.
nested() {
  find "$1" -mindepth 2 -maxdepth 3 -name .git -not -path '*/.worktrees/*' -not -path '*/node_modules/*' 2>/dev/null | while read -r g; do
    local d; d="$(dirname "$g")"; local s; s="$(slug "$d")"
    [[ -n "$s" ]] && echo "$d $s $(git -C "$d" rev-parse HEAD)" # pinned: reference code is read at the commit it is here
  done
}
clone hivecode-app/hive-code "$ENGINE"
chome="$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log((c.companyHome||"~/company").replace(/^~/, process.env.HOME))' "$CONFIG")"
crepo="$(slug "$chome")"
clone "$crepo" "$chome"
for p in ${projects//,/ }; do
  while read -r cpath crepo_p cbranch wdir; do
    [[ -n "$cpath" ]] || continue
    # The engine and the company are set by update_engine and the deploy, not by a project's charter.
    [[ "$cpath" == "$ENGINE" || "$cpath" == "$chome" ]] && continue
    # No `repo` in the charter: the checkout's origin here (the node mirrors this machine).
    [[ -n "$crepo_p" && "$crepo_p" != "-" ]] || crepo_p="$(slug "$cpath")"
    [[ -n "$crepo_p" ]] || { say "דילוג על $cpath: אין לו origin כאן"; continue; }
    clone "$crepo_p" "$cpath" "$cbranch"
    # The worktrees dir is never part of the checkout's status, whether or not its .gitignore says so.
    on "grep -qxF '$wdir/' $cpath/.git/info/exclude 2>/dev/null || echo '$wdir/' >> $cpath/.git/info/exclude" </dev/null
    while read -r npath nrepo nat; do clone "$nrepo" "$npath" "$nat"; done < <(nested "$cpath")
  done < <(node --input-type=module -e '
    const { readCharter } = await import(process.argv[1]);
    const ch = readCharter(process.argv[2], process.argv[3]);
    for (const c of ch?.checkouts ?? []) console.log(c.path, c.repo ?? "-", c.defaultBranch ?? "-", ch.worktreeDir ?? ".worktrees");' "$repo/packages/hq/src/workspace.ts" "$chome/company" "$p")
done
for m in ${mirror//,/ }; do
  m="${m/#\~/$HOME}"
  ms="$(slug "$m")"
  [[ -n "$ms" ]] || { say "דילוג על $m: אין לו origin כאן"; continue; }
  clone "$ms" "$m" "$(at "$m")"
done
say "checkouts: המנוע, החברה, ${projects:-אין פרויקטים}${mirror:+, ועוד $mirror}"
[[ "$mode" == "--projects" ]] && exit 0
update_engine

# ── what a shift reads there: the company's location, the owner's CLAUDE.md and the permission hook ──
on "umask 077; printf '{\"companyHome\": \"%s\"}\n' $chome > $NSTATE/hq.config.json"
for f in CLAUDE.md hooks/permission-authority.mjs; do
  [[ -f "$HOME/.claude/$f" ]] && on "umask 077; cat > $H/.claude/$f" <"$HOME/.claude/$f"
done
say "hq.config.json, CLAUDE.md ו-permission-authority"

# ── the shift unit: one instance per shift, like here, as a system unit of the node's user ──
on "cat > /etc/systemd/system/company-shift@.service && systemctl daemon-reload" <<EOF
# Written by agent-company scripts/node-install.sh: one task shift of hq on hq-host (nodes.ts). Do not edit here.
[Unit]
Description=agent-company shift %i (node $name)
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
Environment=HOME=$H
Environment=DISABLE_AUTOUPDATER=1
# The shifts run as root here (the node has no other user, and none is added: dir-0005). Claude Code refuses
# bypassPermissions as root unless told this is a machine of its own; this node is one, for these shifts.
Environment=IS_SANDBOX=1
Environment=PATH=/usr/local/bin:/usr/bin:/bin
WorkingDirectory=$H
UMask=0077
ExecStart=/usr/bin/env node $ENGINE/packages/shift-host/src/cli.ts --args-file $NSTATE/shifts/%i/host-args.json
Restart=on-failure
RestartSec=1
RestartPreventExitStatus=75 76 2
KillMode=mixed
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF
say "company-shift@.service"

on "[ -s $NSTATE/node-oauth-token ]" && say "יש טוקן" \
  || say "אין עדיין טוקן: claude setup-token לחשבון, ואז scripts/node-install.sh $name --token <file>"
