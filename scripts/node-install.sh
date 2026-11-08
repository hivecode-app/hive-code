#!/usr/bin/env bash
# Set up (or update) a node: another machine that takes task shifts over ssh (packages/hq/src/nodes.ts).
#   scripts/node-install.sh <node>            full setup, idempotent: tools, checkouts, claude, gh, the shift unit
#   scripts/node-install.sh <node> --update   the engine there to this checkout's commit (scripts/deploy.sh hq runs it)
#   scripts/node-install.sh <node> --token <file>   the node's Claude token (claude setup-token), to its own file there
#   scripts/node-install.sh <node> --projects  only the toolchains and the projects' checkouts (after adding a project)
#   scripts/node-install.sh <node> --keys      what a task needs beyond code: ssh to the clusters, the registry login, the projects' keys (below)
# <node> is a name in hq.config.json `nodes`. The node mirrors this machine's paths: $HOME is this machine's $HOME there too (a
# directory, not a user: the shifts run as the node's existing user, root when there is no other), so worktrees,
# sockets and shift dirs are the same paths on both sides. Nothing there is touched beyond those paths, /usr/local
# (node, gh), and /etc/systemd/system/company-shift@.service. Never this machine's ~/.claude (dir-0016).
# A node with `ownLogin` (a machine with a user of its own: a laptop, a second server) is set up as that user, and only under
# ~/.local/share/agent-company, ~/.local/state/agent-company, ~/.config/systemd/user and the checkouts: its packages,
# ~/.claude (its login, CLAUDE.md), git identity and gh login stay as they are, and what is missing is only reported.
# Its ~/flutter only follows this machine's version, as a fast-forward of its own channel (below).
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
H="$HOME"
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

# ── --keys: a task on the node runs end to end (build, push an image, deploy to dev, read the clusters) like here
#    (task 1596, 08/11/2026: 70% of the tasks were kept on the main server, most for a key the node did not have).
#    The node gets ssh keys of its own, made there and authorized on the hosts (revoke: the line `node-<name>-*` in
#    the host's authorized_keys); everything else is a copy of the file here, at the same path. Run again after
#    a file here changes. Production stays as it is (dir-0006): a node is as trusted as the main server. ──
if [[ "$mode" == "--keys" ]]; then
  # What to give comes from the company config (hq.config.json `nodeKeys`), not from here: the hosts the projects'
  # scripts reach as root with ~/.ssh/<key> (the key name is theirs: deploy.sh, node-logs.sh, remote-build.sh), and the
  # files they read from $HOME (git grep '~/.lumo' and the like in their scripts).
  keys_json="$(node -e '
    const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).nodeKeys;
    if (!c) { console.error(`no nodeKeys in ${process.argv[1]}`); process.exit(1); }
    for (const [k, hs] of Object.entries(c.hosts || {})) console.log(`host ${k} ${hs.join(" ")}`);
    for (const f of c.files || []) console.log(`file ${f}`);' "$CONFIG")"
  failed=0
  while read -r kind key hosts; do
    [[ "$kind" == host ]] || continue
    pub="$(on "set -e; install -d -m700 $H/.ssh; [ -f $H/.ssh/$key ] || ssh-keygen -q -t ed25519 -N '' -C node-$name-$key -f $H/.ssh/$key; cat $H/.ssh/$key.pub" </dev/null)"
    ok=()
    for h in $hosts; do
      # A newline first when the file does not end with one: else the key is glued to the last key there, and both stop working.
      ssh -n -o BatchMode=yes -i "$HOME/.ssh/$key" "root@$h" "install -d -m700 ~/.ssh; f=~/.ssh/authorized_keys; touch \$f; chmod 600 \$f
          grep -qxF '$pub' \$f || { [ ! -s \$f ] || [ -z \"\$(tail -c1 \$f)\" ] || echo >> \$f; echo '$pub' >> \$f; }" \
        || { say "לא הצלחתי להוסיף את $key ב-$h"; failed=1; continue; }
      { ssh-keygen -F "$h" -f "$HOME/.ssh/known_hosts" || true; } | grep -v '^#' \
        | on "touch $H/.ssh/known_hosts; while read -r l; do grep -qxF \"\$l\" $H/.ssh/known_hosts || echo \"\$l\" >> $H/.ssh/known_hosts; done"
      on "grep -qx 'Host $h' $H/.ssh/config 2>/dev/null || printf '\\nHost %s\\n  User root\\n  IdentityFile ~/.ssh/%s\\n  IdentitiesOnly yes\\n' $h $key >> $H/.ssh/config; chmod 600 $H/.ssh/config" </dev/null
      ok+=("$h")
    done
    say "$key: ${ok[*]:-אף שרת}"
  done <<<"$keys_json"
  have=(); missing=()
  while read -r kind f _; do [[ "$kind" == file ]] || continue; if [[ -e "$HOME/$f" ]]; then have+=("$f"); else missing+=("$f"); fi; done <<<"$keys_json"
  ((${#missing[@]} == 0)) || { say "אין כאן, ולכן לא הועתקו: ${missing[*]}"; failed=1; }
  if ((${#have[@]})); then tar -C "$HOME" -czf - "${have[@]}" | on "cd $H && tar -xzf -"; say "קבצים: ${have[*]}"; fi
  # The registry: only the ghcr.io entry of docker's config here (the rest is this machine's).
  if node -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).auths?.["ghcr.io"]; if(!a) process.exit(1); process.stdout.write(JSON.stringify(a));' "$HOME/.docker/config.json" 2>/dev/null \
    | on "set -e; install -d -m700 $H/.docker; f=$H/.docker/config.json; [ -s \$f ] || echo '{}' > \$f
          node -e 'const fs=require(\"fs\"),f=process.argv[1],c=JSON.parse(fs.readFileSync(f,\"utf8\"));c.auths={...c.auths,\"ghcr.io\":JSON.parse(fs.readFileSync(0,\"utf8\"))};fs.writeFileSync(f,JSON.stringify(c,null,2),{mode:0o600})' \$f"; then
    say "ghcr.io"
  else say "ההתחברות ל-ghcr.io לא הועתקה"; failed=1; fi
  ((failed == 0)) || { echo "node-install --keys: חלק לא הושלם (למעלה). אחרי התיקון מריצים שוב, ואז \`keys: true\` ל-$name ב-hq.config.json" >&2; exit 1; }
  say "הכול הועבר. אם עוד אין, \`keys: true\` ל-$name ב-hq.config.json"
  exit 0
fi
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
# On a machine with a user of its own ~/flutter is the user's, but the charters' commands name it, and another version
# writes into the worktrees (3.47.0's `pub get` adds web/windows/macos/linux excludes to every analysis_options.yaml,
# which 3.47.2 does only for the dirs that exist). So it follows this machine's tag, only as a fast-forward of the
# branch it is on (its channel stays), with no changes of its own and no dart of it running; otherwise it is said.
if [[ "$own" == 1 && -x "$HOME/flutter/bin/flutter" ]]; then
  fver="$(git -C "$HOME/flutter" describe --tags --exact-match 2>/dev/null || true)"
  if [[ -z "$fver" ]]; then
    say "flutter כאן לא על תג, ולכן flutter שם לא הושווה אליו"
  else
    rc=0
    # [/]: pgrep matches the command line of this very shell, which holds the path too, but not the pattern itself
    on "d=$H/flutter; tagof() { git -C \$d describe --tags --exact-match 2>/dev/null; }; [ -d \$d/.git ] || exit 3
        [ \"\$(tagof)\" = $fver ] && exit 0
        [ -z \"\$(git -C \$d status --porcelain --untracked-files=no)\" ] && git -C \$d symbolic-ref -q HEAD >/dev/null || exit 4
        ! pgrep -f '[/]${H#/}/flutter/bin/cache/dart-sdk' >/dev/null || exit 5
        git -C \$d fetch --quiet origin tag $fver && git -C \$d merge --quiet --ff-only $fver || exit 4
        [ \"\$(tagof)\" = $fver ] || exit 4 # already past it: the merge did nothing
        \$d/bin/flutter --version >/dev/null 2>&1 || exit 6" </dev/null || rc=$?
    case $rc in
      0) say "flutter $fver" ;;
      3) say "אין שם ~/flutter כ-checkout של git: הפקודות של האמנות לא ירוצו שם" ;;
      4) say "flutter שם לא ב-$fver ולא עודכן (שינויים שם, לא על ענף, או שהוא לא לפני $fver בענף שלו): מעדכנים שם ביד" ;;
      5) say "flutter שם לא ב-$fver, ורץ שם עכשיו: לא עודכן. מריצים שוב --projects כשהוא פנוי" ;;
      6) say "flutter שם עבר ל-$fver, אבל flutter --version שם נכשל: בודקים שם" ;;
      *) say "flutter שם לא נבדק: ה-ssh נכשל ($rc)" ;;
    esac
  fi
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
slug() { git -C "$1" remote get-url origin 2>/dev/null | sed -nE 's#^(git@github\.com:|https://github\.com/)##p' | sed -E 's#\.git$##'; }
# Repos inside a checkout that git there does not track (a project's server/ and reference/*): the same, at the same path
# and commit (scripts/repo-sync.sh; nodes.ts nestedRepos finds the same ones).
pins=()
nested() { # <checkout> <worktree dir>
  find "$1" -mindepth 2 -maxdepth 3 -name .git -not -path "$1/$2/*" -not -path '*/node_modules/*' 2>/dev/null | while read -r g; do
    local d; d="$(dirname "$g")"; local s; s="$(slug "$d")"
    # GitHub only (repo-sync clones from there); pinned: reference code is read at the commit it is here
    [[ -n "$s" ]] && echo "$d $s $(git -C "$d" rev-parse HEAD)"
  done
}
chome="$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log((c.companyHome||"~/company").replace(/^~/, process.env.HOME))' "$CONFIG")"
# The engine moves with each deploy and the company with each task op there (workspace-cli syncCompany): ours only.
ours "$ENGINE"; ours "$chome"
# The engine from where this checkout comes from (its origin).
engine_repo="$(slug "$repo")"
[[ -n "$engine_repo" ]] || { echo "node-install: the origin of $repo is not a GitHub repo" >&2; exit 1; }
clone "$engine_repo" "$ENGINE"
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
    while read -r npath nrepo nat; do pins+=("$npath" "$nrepo" "$nat"); done < <(nested "$cpath" "$wdir")
  done < <(node --input-type=module -e '
    const { readCharter } = await import(process.argv[1]);
    const ch = readCharter(process.argv[2], process.argv[3]);
    for (const c of ch?.checkouts ?? []) console.log(c.path, c.repo ?? "-", c.defaultBranch ?? "-", ch.worktreeDir ?? ".worktrees");' "$repo/packages/hq/src/workspace.ts" "$chome/company" "$p")
done
for m in ${mirror//,/ }; do
  m="${m/#\~/$HOME}"
  ms="$(slug "$m")"
  [[ -n "$ms" ]] || { say "דילוג על $m: אין לו origin ב-GitHub כאן"; continue; }
  pins+=("$m" "$ms" "$(git -C "$m" rev-parse HEAD)")
done
# The nested repos and the mirrors at the commit they are on here, also when they are there already (a new pin here
# reaches the node). hq runs the same after each task's worktree there (nodes.ts RemoteWorkspaces.create).
if ((${#pins[@]})); then
  on "bash -s -- $own $(printf '%q ' "${pins[@]}")" <"$repo/scripts/repo-sync.sh" | while read -r line; do say "$line"; done
fi
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
# The shifts' PATH is its user's login PATH (~/.local/bin, ~/go/bin, /usr/local/go/bin, ~/flutter/bin), after $BIN: a tool
# its user has is a tool the shifts have. Until 08/11/2026 it was $BIN:/usr/local/bin:/usr/bin:/bin, and kubectl, sops, go
# and flutter on ci-host were there and not found, so tasks moved to the main server for tools it had (task 1596).
login_path="$(on 'bash -lc '"'"'printf %s "$PATH"'"'"'' </dev/null | tr ':' '\n' | awk -v bin="$BIN" 'NF && $0 != bin && !seen[$0]++' | paste -sd: -)"
SPATH="$BIN:${login_path:-/usr/local/bin:/usr/bin:/bin}"
on "install -d $H/.config/systemd/user && cat > $H/.config/systemd/user/company-shift@.service && XDG_RUNTIME_DIR=/run/user/\$(id -u) systemctl --user daemon-reload" <<UNIT
# Written by agent-company scripts/node-install.sh: one task shift of hq on the main server (nodes.ts). Do not edit here.
[Unit]
Description=agent-company shift %i (node $name)
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
Environment=HOME=$H
Environment=DISABLE_AUTOUPDATER=1
Environment=PATH=$SPATH
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
# Written by agent-company scripts/node-install.sh: one task shift of hq on the main server (nodes.ts). Do not edit here.
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
