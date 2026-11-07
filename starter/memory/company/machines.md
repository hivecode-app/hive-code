# The machines

A template. The manager fills it in during the setup conversation, one machine per section. Every machine listed here also appears in `machines` in `company/org.yaml`.

## <hostname> (the main server)

As of DD/MM/YYYY.

- **Hardware:** `<nproc>` cores, `<free -g>` GB memory, `<df -h ~>` free disk. Operating system: `<lsb_release -ds>`.
- **Capacity:** about 5GB memory per active session, builds included. 16GB is enough for two workers in parallel, 32GB for five.
- **Access:** how to get in (ssh alias, Tailscale), without keys and passwords.
- **hq's address:** the domain, or the Tailscale Funnel address.
- **Services:** `agent-company-hq` and `company-shift@` (systemd user). Other services running on the machine and who is responsible for them.
- **Incidents:** faults and what helped, with a date.
