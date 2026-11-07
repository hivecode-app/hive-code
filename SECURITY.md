# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub: on the repository's **Security** tab, choose **Report a vulnerability**.

Include what you found, how to reproduce it, and what an attacker could do with it. We will confirm we received it and keep you updated until it is fixed.

## Supported versions

Hive Code is in early access. Security fixes go into the latest release only. Run `company update` to get it.

## The security model, in short

Read this before you report, because some of it is by design:

- **Workers have full access to the server and to the accounts signed in on it.** They run Claude Code with `bypassPermissions`, and the installer asks you to accept this explicitly. A worker running a command you did not expect is not, on its own, a vulnerability.
- **`hq` listens on `127.0.0.1` only.** It is reachable from outside only through the address you configured (Tailscale Funnel, Cloudflare Tunnel or your own domain), over HTTPS.
- **Devices sign in with a short-lived pairing code or a passkey,** and each device gets its own token that you can revoke.
- **Hive Code has no backend of its own and sends no telemetry.**

What we especially want to hear about:

- Any way to reach `hq`'s API, the app or a worker without a valid device token.
- Any way for content a worker reads (a web page, an issue, a file in a repository) to make Hive Code act outside that worker's task, beyond what Claude Code itself allows.
- Secrets that end up somewhere they should not: logs, `company doctor` output, backups shared outside the server, or the app.
- Weaknesses in pairing, passkeys, tokens or the update and install checks (`SHA256SUMS`).
