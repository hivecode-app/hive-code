# Install

Hive Code runs on a Linux server you own, as your regular user, with your Claude subscription. Nothing outside your server gets access to it.

## Requirements

- **A Linux server:** Ubuntu or Debian with systemd, x86_64 or arm64. At least 16 GB of memory (each active worker uses about 5 GB) and about 40 GB of free disk.
- **A regular user with sudo.** The installer itself runs without sudo. When it needs something that does (for example `loginctl enable-linger`), it stops and prints the command. Run it, then run the installer again.
- **On the server:** `git`, `curl` and `tar`. If Node 22.18 or newer or the GitHub CLI `gh` is missing, the installer puts a pinned version of each in your user directory, checked against its SHA-256. `ffmpeg`, `pdftoppm` and `tesseract` are optional: without them workers cannot read voice notes, PDFs or text in images.
- **A Claude Pro or Max subscription.** The installer signs in to it once, in your browser.
- **A GitHub account.** The installer signs `gh` in with a one-time code you enter at `github.com/login/device`. Workers open pull requests with it.
- **A way for your phone to reach the server,** one of:
  1. **Tailscale Funnel** (the default when you have no domain): a free Tailscale account, Tailscale on the server, and MagicDNS and HTTPS turned on in your tailnet. You get a stable `https://<server>.<tailnet>.ts.net` address.
  2. **Cloudflare Tunnel:** a domain managed by Cloudflare and a tunnel token.
  3. **Your own domain** pointing at the server, with ports 80 and 443 open.
- **A phone:** Android has an app. On iPhone, use the browser.

## Run the installer

```sh
curl -fsSL https://raw.githubusercontent.com/hivecode-app/hive-code/main/scripts/install.sh | bash
```

Pass options after `bash -s --`, for example `| bash -s -- --address funnel`. `--help` lists all of them.

To read the plan first without changing anything:

```sh
curl -fsSL https://raw.githubusercontent.com/hivecode-app/hive-code/main/scripts/install.sh | bash -s -- --dry-run
```

The installer prints each of its eight steps as it goes. Its output is in Hebrew today; only the consent text in step 2 comes in English (the default) or Hebrew (`--language he`). An English version of the rest is planned. `--dry-run` prints the plan in English.

1. **Requirements.** If something is missing it says what, and stops.
2. **Full access and responsibility.** Workers run with full permissions on the server: they can delete files, run commands, deploy and work in your repositories. You type a confirmation to continue.
3. **Engine.** Hive Code is installed under `~/.local/share/agent-company`, from the latest release, checked against its `SHA256SUMS`.
4. **Claude Code and GitHub.** Claude Code is installed at the version this release is tested with, and you sign in: a link opens, you sign in in the browser and paste the code back. A one-minute check follows. A `claude` you already have is left as it is. Then `gh` signs in to GitHub with a one-time code, unless it already is.
5. **Company.** Your company is created in `~/company` as a local git repository.
6. **Public address.** You choose Funnel, Tunnel or your own domain.
7. **`hq` and the browser.** The workers' browser is installed too: Chromium, Playwright MCP and browser-memory, which keeps what workers learn about each site and the sign-ins you give them. It runs headless on the server, reachable only from the server itself. If Chromium is missing system libraries, the installer stops and prints one `sudo` command that installs them. Everything runs as systemd user services, with a daily backup and disk cleanup, so it keeps running after you log out and after a reboot. With Funnel, the installer may print a link to approve Funnel in your tailnet: open it, approve, and run the installer again. At the end of this step it prints a QR code to pair your phone.
8. **Check from outside.** The installer checks that the address answers.

If it stops halfway, fix what it reported and run the same command again. It continues from what is already installed.

Workers run with full permissions, but five kinds of commands are always refused, in every installation: a recursive delete of `/`, your home or a system directory, formatting a filesystem, writing directly to a disk, a fork bomb, and shutting down or rebooting the server.

## Pair your phone

- **The QR code** in the terminal carries a pairing code that is valid for 10 minutes. Scan it with your phone's camera.
- **On Android,** if the app is not installed yet, download it from `https://<your address>/agent-company.apk`. It does not come from Google Play, so Android asks you to allow installs from this source. Then scan again. You can also choose to continue in the browser.
- **On iPhone,** continue in the browser.

If the code expires before you scan it, get a new one:

```sh
company pair
```

Then continue with [getting started](getting-started.md).

## Everyday commands

| Command | What it does |
|---|---|
| `company status` | Shows whether the local server is up, and how far the company setup in the app has gone |
| `company pair` | A new pairing code and QR, to connect another device |
| `company update` | Installs a newer release, checks it, restarts safely and rolls back if the check fails |
| `company doctor` | Writes one file with everything support needs (below) |
| `company check` | Checks your company's files (`~/company`) for mistakes |

If `company` is not found, open a new terminal or run `~/.local/bin/company`.

## When something does not work

```sh
company doctor
```

It writes `company-doctor-<date>.txt` in the current directory, with versions, service status, the address, recent logs and an install check. Conversations are not included, and it masks the secrets it recognizes, but it cannot recognize every secret. The file is not sent anywhere. Read it before you share it.

## Backups

Every day the installer's timer saves a snapshot under `~/.local/state/agent-company/daily-backups/`: the database (`hq.db`), your company as a git bundle (`company.bundle`) and an archive of it (`company.tar.gz`).

The backup is **on the same disk**. It does not protect you from losing the disk or the machine, and it can contain secrets. Copy it to protected storage if you want an off-machine copy. To restore, clone the bundle and extract the archive into the clone, then open the database and check its integrity before you replace a stopped installation. Do not copy a live SQLite file without its WAL.

A second timer cleans up only incomplete backups left by processes that died. It does not touch Docker, `/tmp` or your journal.

## Uninstall

1. Stop `hq` first, so it does not start new shifts: `systemctl --user disable --now agent-company-hq.service`.
2. Stop the workers' sessions: for each shift that `systemctl --user list-units --all 'company-shift@*'` lists, run `systemctl --user disable --now <name>`.
3. Stop and disable the rest: `systemctl --user list-unit-files 'agent-company*'` lists the services and timers, and for each one run `systemctl --user disable --now <name>`.
4. Remove the unit files from `~/.config/systemd/user/`: the `agent-company*` files and `company-shift@.service`. Then run `systemctl --user daemon-reload`.
5. Remove `~/.local/share/agent-company`, `~/.local/state/agent-company`, `~/.config/agent-company` and the links `~/.local/bin/company` and `~/.local/bin/company-run`.
6. If you used Tailscale Funnel, turn it off with `tailscale funnel reset`.

Your company in `~/company` is a regular git repository: keep it or delete it.
