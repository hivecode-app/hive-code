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
# A node with `ownLogin` (a machine with a user of its own: the laptop, ci-host) is set up as that user, and only under
# ~/.local/share/agent-company, ~/.local/state/agent-company, ~/.config/systemd/user and the checkouts: its packages,
# ~/.claude (its login, CLAUDE.md), git identity and gh login stay as they are, and what is missing is only reported.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/.." && pwd)"
name="${1:?usage: node-install.sh <node> [--update | --token <file>]}"
mode="${2:-install}"
STATE="${AGENT_COMPANY_STATE:-$HOME/.local/state/agent-company}"
CONFIG="$STATE/hq.config.json"
[[ -f "$CONFIG" ]] || CONFIG="${HQ_CONFIG_SRC:-$HOME/company/company/hq.config.json}"

read -r ssh_target ssh_key projects mirror own < <(node -e '
  const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const n = (c.nodes || []).find((x) => x.name === process.argv[2]);
  if (!n) { console.error(`no node ${process.argv[2]} in ${process.argv[1]}`); process.exit(1); }
  console.log(n.ssh, n.identityFile || "-", (n.projects || []).join(",") || "-", (n.mirror || []).join(",") || "-", n.ownLogin ? 1 : 0);' "$CONFIG" "$name")
[[ "$projects" == "-" ]] && projects=""
[[ "$mirror" == "-" ]] && mirror=""
ssh_args=(-o BatchMode=yes -o ConnectTimeout=15)
[[ "$ssh_key" != "-" ]] && ssh_args+=(-i "${ssh_key/#\~/$HOME}")
H=/home/owner
NSTATE="$H/.local/state/agent-company"
ENGINE="$H/projects/agent-company"
BIN="$H/.local/share/agent-company/bin" # nodes.ts NODE_BIN: first on the PATH there
on() { ssh "${ssh_args[@]}" "$ssh_target" "export HOME=$H PATH=$BIN:/usr/local/bin:\$PATH; $1"; }
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
# A checkout node-install cloned carries this mark. On a machine with a user of its own, the engine and the company are
# moved (checkout --detach, npm ci) only when they carry it: a checkout of his at that path is his, and stays as it is.
MARK=.git/agent-company-node
ours() { # <path>: dies when it is there and is not ours (ownLogin only)
  [[ "$own" == 1 ]] || return 0
  local rc=0
  on "[ ! -e $1 ] || [ -e $1/$MARK ]" </dev/null || rc=$?
  ((rc != 255)) || { echo "node-install: $name does not answer (ssh)" >&2; exit 1; }
  ((rc == 0)) || { echo "node-install: $1 there is not a checkout of node-install (no $MARK): it stays as it is; move it, or mark it by hand if it is ours" >&2; exit 1; }
}

update_engine() {
  ours "$ENGINE"
  on "set -e; cd $ENGINE; git fetch --quiet origin; before=\$(git rev-parse HEAD); git checkout --quiet --detach $sha
      if [ ! -d node_modules ] || ! git diff --quiet \$before $sha -- package-lock.json; then npm ci --no-audit --no-fund >/dev/null; fi"
  # `company-run` (reserve, resources-design.md): on the PATH of a shift here, which is /usr/local/bin and not ~/.local/bin.
  on "install -d $BIN; if [ \"\$(id -u)\" = 0 ]; then ln -sfn $ENGINE/scripts/company-run /usr/local/bin/company-run; else ln -sfn $ENGINE/scripts/company-run $BIN/company-run; fi"
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
if [[ "$own" == 1 ]]; then
  # Its packages are its user's: what is missing is said, not installed. Node, when it has none or an older major than
  # ours, is a private one linked into $BIN (the user's own node stays what his shell finds).
  missing="$(on 'for t in git make g++ jq unzip docker curl xz; do command -v $t >/dev/null || printf "%s " $t; done')"
  [[ -z "$missing" ]] || say "חסרים שם: $missing(לא מותקנים: החבילות שם של המשתמש שלו)"
  major="${nodever%%.*}"; major="${major#v}"
  on "v=\$(node -v 2>/dev/null || echo v0); v=\${v%%.*}; [ \"\${v#v}\" -ge $major ]" || on "set -e; d=$H/.local/share/agent-company/node
      rm -rf \$d.tmp; install -d \$d.tmp $BIN
      curl -fsSL https://nodejs.org/dist/$nodever/node-$nodever-linux-x64.tar.xz | tar -xJ -C \$d.tmp --strip-components=1
      rm -rf \$d; mv \$d.tmp \$d; for b in node npm npx; do ln -sfn \$d/bin/\$b $BIN/\$b; done"
  say "node $(on 'node -v') ב-PATH של המשמרות"
else
on "set -e; export DEBIAN_FRONTEND=noninteractive
    command -v git >/dev/null && command -v make >/dev/null && command -v g++ >/dev/null && command -v jq >/dev/null && command -v unzip >/dev/null \
      || { apt-get update -qq; apt-get install -y -qq git build-essential python3 xz-utils curl jq unzip >/dev/null; }
    command -v node >/dev/null || curl -fsSL https://nodejs.org/dist/$nodever/node-$nodever-linux-x64.tar.xz | tar -xJ -C /usr/local --strip-components=1
    command -v gh >/dev/null || apt-get install -y -qq gh >/dev/null
    command -v docker >/dev/null || apt-get install -y -qq docker.io >/dev/null"
say "git, build-essential, jq, unzip, docker, node $nodever, gh"
fi

# ── toolchains: the same Go and Flutter as here, at the same paths (the charters' commands name them). Not on a
#    machine with a user of its own: /usr/local is not ours there, and the projects it takes do not need them ──
if [[ "$own" == 1 ]]; then
  :
elif [[ -x /usr/local/go/bin/go ]]; then
  gover="$(/usr/local/go/bin/go env GOVERSION)"
  on "/usr/local/go/bin/go env GOVERSION 2>/dev/null | grep -qx $gover || { curl -fsSL https://go.dev/dl/$gover.linux-amd64.tar.gz -o /tmp/go.tgz && rm -rf /usr/local/go && tar -C /usr/local -xzf /tmp/go.tgz && rm /tmp/go.tgz; }"
  say "go $gover"
fi
if [[ "$own" != 1 && -x "$HOME/flutter/bin/flutter" ]]; then
  fver="$(git -C "$HOME/flutter" describe --tags --exact-match 2>/dev/null || git -C "$HOME/flutter" rev-parse HEAD)"
  on "set -e; [ -d $H/flutter/.git ] || git clone --quiet --depth 1 -b $fver https://github.com/flutter/flutter.git $H/flutter
      [ \"\$(git -C $H/flutter describe --tags --exact-match 2>/dev/null)\" = $fver ] || { git -C $H/flutter fetch --quiet --depth 1 origin tag $fver && git -C $H/flutter checkout --quiet $fver; }
      $H/flutter/bin/flutter --version >/dev/null 2>&1" </dev/null
  say "flutter $fver"
fi

# ── dirs, git identity and GitHub (this machine's gh token: workers push and open PRs there) ──
if [[ "$own" == 1 ]]; then
  # Its home, ~/projects and ~/.claude keep their modes: only what is missing is made. Our state dir is ours.
  on "mkdir -p $H/projects $H/.claude/hooks $H/.local/state && install -d -m700 $NSTATE $NSTATE/shifts"
else
on "install -d -m700 $H $H/projects $H/.claude $H/.claude/hooks $H/.local/state $NSTATE $NSTATE/shifts"
fi
if [[ "$own" == 1 ]]; then
  # Its own gh login and git identity: checked, never replaced.
  ghuser="$(gh api user -q .login)"
  there="$(on 'gh api user -q .login 2>/dev/null || true')"
  [[ "$there" == "$ghuser" ]] || { echo "node-install: gh there is '${there:-not logged in}', not $ghuser: gh auth login there first" >&2; exit 1; }
  on "git config --global user.email >/dev/null || git config --global user.email $(printf %q "$(git config --global user.email)")
      git config --global user.name >/dev/null || git config --global user.name $(printf %q "$(git config --global user.name)")
      git config --global --get-regexp '^credential\..*github\.com.*helper' >/dev/null || gh auth setup-git"
  say "gh שם מחובר כ-$ghuser, וזהות ה-git שלו נשארה"
else
on "git config --global user.name $(printf %q "$(git config --global user.name)") && git config --global user.email $(printf %q "$(git config --global user.email)")"
gh auth token | on "gh auth login --with-token && gh auth setup-git"
say "git ו-gh מחוברים כמו כאן"
fi

# ── the checkouts: the engine, the company (COMPANY_HOME), and those of every project the node takes ──
clone() { # <owner/name> <path> [branch or commit]; stdin closed: inside `while read` ssh would eat the loop's input
  # Only a fresh clone goes to the branch or commit: one that is there already is left as it is (the engine there is
  # detached on the deployed commit, and a worker's checkout may be anywhere).
  local to="${3:-}"
  on "set -e; if [ ! -d $2/.git ]; then git clone --quiet https://github.com/$1 $2; touch $2/$MARK
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
chome="$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log((c.companyHome||"~/company").replace(/^~/, process.env.HOME))' "$CONFIG")"
# The engine moves with each deploy and the company with each task op there (workspace-cli syncCompany): ours only.
ours "$ENGINE"; ours "$chome"
clone hivecode-app/hive-code "$ENGINE"
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
if [[ "$own" == 1 ]]; then
  # The permission hook (the shifts pass it in --settings; nothing of its user's loads it): written where there is none,
  # or where the one there is what node-install wrote last (its sha in $NSTATE), so an update reaches it. One its user
  # changed stays. Its CLAUDE.md is its user's: the shifts get the Authority section from the company's directives.
  f=hooks/permission-authority.mjs
  new="$(sha256sum <"$HOME/.claude/$f" | cut -d' ' -f1)"
  # One it cannot read (cur empty) is not ours to overwrite; ssh that does not answer (255) is said as such.
  rc=0
  on "[ ! -e $H/.claude/$f ] || { cur=\$(sha256sum < $H/.claude/$f | cut -d' ' -f1); [ -n \"\$cur\" ] && { [ \"\$cur\" = $new ] || [ \"\$cur\" = \"\$(cat $NSTATE/permission-authority.sha 2>/dev/null)\" ]; }; }" </dev/null || rc=$?
  ((rc != 255)) || { echo "node-install: $name does not answer (ssh)" >&2; exit 1; }
  if ((rc == 0)); then
    on "umask 077; cat > $H/.claude/$f.tmp && mv -f $H/.claude/$f.tmp $H/.claude/$f && echo $new > $NSTATE/permission-authority.sha" <"$HOME/.claude/$f"
  else
    say "permission-authority שם שונה מכאן ולא נכתב על ידינו: נשאר כמו שהוא"
  fi
  say "hq.config.json ו-permission-authority (ב-CLAUDE.md שם לא נגענו)"
else
for f in CLAUDE.md hooks/permission-authority.mjs; do
  [[ -f "$HOME/.claude/$f" ]] && on "umask 077; cat > $H/.claude/$f" <"$HOME/.claude/$f"
done
say "hq.config.json, CLAUDE.md ו-permission-authority"
fi

if [[ "$own" == 1 ]]; then
# ── the shift unit as a unit of its user (nodes.ts SC), like the shifts here; linger keeps it up with no login ──
on "[ \"\$(loginctl show-user \$(id -un) -p Linger --value 2>/dev/null)\" = yes ] || sudo -n loginctl enable-linger \$(id -un)" \
  || { echo "node-install: linger is off there and sudo wants a password: loginctl enable-linger there first" >&2; exit 1; }
on "install -d $H/.config/systemd/user && cat > $H/.config/systemd/user/company-shift@.service && XDG_RUNTIME_DIR=/run/user/\$(id -u) systemctl --user daemon-reload" <<UNIT
# Written by agent-company scripts/node-install.sh: one task shift of hq on hq-host (nodes.ts). Do not edit here.
[Unit]
Description=agent-company shift %i (node $name)
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
Environment=HOME=$H
Environment=DISABLE_AUTOUPDATER=1
Environment=PATH=$BIN:/usr/local/bin:/usr/bin:/bin
WorkingDirectory=$H
UMask=0077
ExecStart=/usr/bin/env node $ENGINE/packages/shift-host/src/cli.ts --args-file $NSTATE/shifts/%i/host-args.json
Restart=on-failure
RestartSec=1
RestartPreventExitStatus=75 76 2
KillMode=mixed
TimeoutStopSec=20

[Install]
WantedBy=default.target
UNIT
say "company-shift@.service (systemd --user, linger)"
on "[ -s $H/.claude/.credentials.json ]" && say "המשמרות רצות על ההתחברות של Claude שם" \
  || say "אין שם התחברות של Claude: claude auth login שם, כמשתמש שלו"
exit 0
fi

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
