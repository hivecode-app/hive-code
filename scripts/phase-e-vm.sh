#!/usr/bin/env bash
# Run on a disposable Ubuntu/Debian VM, as its regular user. Default is a read-only plan.
set -euo pipefail
phase_e_engine="$(cd "$(dirname "$0")/.." && pwd -P)"
case "${1:---plan}" in
  --plan)
    cat <<'PLAN'
1. On a clean VM: install Node >=22.18, npm, git, gh and curl. Provide 16GB RAM and systemd --user.
2. Clone this engine and run: bash scripts/phase-e-vm.sh --install
3. Connect Claude and GitHub on that VM. Run: company status; company pair
4. Pair the phone. Confirm access, read terms, choose two repositories, and continue in the manager conversation.
5. Finish setup. The first task should reach a reviewed PR and an approval request within 20 minutes.
6. Run: bash scripts/phase-e-vm.sh --verify
7. Complete docs/product/phase-e-vm-checklist.md with results and evidence. Stop before release or deployment.
PLAN
    ;;
  --install)
    exec bash "$phase_e_engine/scripts/install.sh" --repo "$phase_e_engine" --version HEAD --address local
    ;;
  --verify)
    for timer in agent-company-backup.timer agent-company-disk-clean.timer; do
      systemctl --user is-enabled "$timer"
      systemctl --user is-active "$timer"
    done
    company status
    node "$phase_e_engine/scripts/check-contract.mjs" "${COMPANY_HOME:-$HOME/company}"
    node "$phase_e_engine/scripts/daily-backup.mjs" "${AGENT_COMPANY_STATE:-$HOME/.local/state/agent-company}" "${COMPANY_HOME:-$HOME/company}"
    echo 'Automated VM checks passed. Complete the phone and restore checks in the checklist.'
    ;;
  *) echo 'usage: phase-e-vm.sh [--plan|--install|--verify]' >&2; exit 2 ;;
esac
