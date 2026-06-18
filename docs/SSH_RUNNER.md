# Ark SSH Runner

The keystone subsystem that unlocks scheduled hardening (Phase 7.6),
online-Pi updates (Phase 8), and source-side image capture (Phase 6.7).

Lets the Ark Hub run commands against operator-managed hosts (Pis,
servers, routers with SSH enabled) and stream the results back to the
UI. The Hub shells out to the system `ssh` binary using the
operator's existing keys + `~/.ssh/config` + `~/.ssh/known_hosts`.
Ark never sees or stores credentials.

## Architecture

```
Browser UI → POST /api/runner/hosts/<id>/exec { command }
              ↓
Hub runner.mjs::exec(hostId, command)
              ↓
spawn('ssh', [-o BatchMode=yes, -p <port>,
              ssh_target, '--', command])  (array form; no shell injection)
              ↓
captures stdout / stderr / exit_code / duration_ms
              ↓
INSERT into runner_log; UPDATE managed_hosts.last_status
              ↓
Returns { ok, exit_code, stdout, stderr, duration_ms }
```

Strict ssh_target validation (`user@host[:port]`) at the Hub keeps
arbitrary shell from being smuggled into the spawn args. The remote
command itself runs in a shell on the remote host — that shell sees
whatever the operator typed, which is the desired behaviour.

## Tables

```sql
managed_hosts(id, label, ssh_target, ssh_port, identity_file, notes,
              added_at, last_reached_at, last_status)

runner_log(id, host_id, command, exit_code, stdout_tail, stderr_tail,
           duration_ms, ran_at, reason)
```

stdout/stderr stored as 4 KB tails to bound DB size; full output is
returned to the immediate caller via the API.

## Endpoints

```
GET    /api/runner/hosts
POST   /api/runner/hosts              { label, ssh_target, ssh_port?, identity_file?, notes? }
DELETE /api/runner/hosts/<id>
POST   /api/runner/hosts/<id>/test    → exec "echo ark-runner-ok"
POST   /api/runner/hosts/<id>/exec    { command, reason?, timeoutMs? }
GET    /api/runner/hosts/<id>/log     → last 50 commands
POST   /api/cph/hardening/run         { host_id, check_id }
                                       → runs the check's probe via SSH,
                                         classifies pass/fail via
                                         security.classifyCheckOutput,
                                         records finding
```

## What enables what

| Phase | How the SSH Runner unblocks it |
|---|---|
| **7.6** Scheduled hardening | Each HARDENING_CHECK now has a `probe` (shell command) + `pass_when` (predicate). Hub runs the probe on a managed host, classifies the output, records a finding. UI button: "Run on \<host>". Future: cron that runs every N hours. |
| **8** Online-Pi updates | Hub can push a fresh install.plan.sh to a running Pi via `scp` (shell out) + run it, without re-flashing. |
| **6.7** Clone / Capture (partial) | Hub can SSH into a Pi and stream `dd if=/dev/mmcblk0` back over the connection to capture a golden image. |
| **4.5 / 4.6** | Drift + health checks could SSH for richer signals than the agent telemetry (`apt list --upgradable`, `systemctl status`). |

## Security posture

| Aspect | Posture |
|---|---|
| Auth | Operator's existing SSH keys / ssh-agent. Ark never sees private keys. |
| Host verification | `StrictHostKeyChecking=accept-new` — first connection adds the key to known_hosts; subsequent connections strict. |
| Privilege escalation | None. The Hub never `sudo`s. If a probe needs sudo, that's the operator's job (NOPASSWD entry, or use ssh-agent + the sudo-without-tty pattern). |
| Command injection | Spawn array-form prevents shell expansion of the ssh_target / port. The command string itself goes to the remote shell which the operator wants. |
| Network exposure | Hub binds to `ARK_HUB_BIND_HOST` (defaults 127.0.0.1; LAN-bindable on demand). |
| Logs | Every command logged with timestamp + reason. stdout/stderr tails persisted (4 KB each). |

## Use cases — concrete

```sh
# Add SinseraCore (already SSH-reachable via existing key)
curl -X POST http://localhost:7400/api/runner/hosts \
  -H 'content-type: application/json' \
  -d '{"label":"SinseraCore","ssh_target":"pi@SinseraCore.local"}'

# Test connectivity
curl -X POST http://localhost:7400/api/runner/hosts/1/test

# Run an ad-hoc check
curl -X POST http://localhost:7400/api/runner/hosts/1/exec \
  -H 'content-type: application/json' \
  -d '{"command":"uname -a && uptime"}'

# Run a hardening check
curl -X POST http://localhost:7400/api/cph/hardening/run \
  -H 'content-type: application/json' \
  -d '{"host_id":1,"check_id":"ssh.password-auth-disabled"}'
```

## What still needs building

1. **Scheduled cron for hardening runs.** Schema + endpoint exist; the
   Hub-side scheduler that fires checks every N hours is not wired.
2. **`scp` push for install plans (Phase 8 properly).** Runner can
   exec; pushing files needs a parallel helper.
3. **Source-side `dd` streaming (Phase 6.7 partial).** Needs streaming
   from ssh stdout back to a Flash Node image store; substantial
   code.
4. **Sudo support.** Today probes that need root must run from a
   privileged user OR use a NOPASSWD sudoers entry. No UI workflow
   for storing sudo passwords (and probably never should be — keep
   it operator-managed).
5. **TTY allocation for interactive commands.** Current `ssh -- cmd`
   is non-interactive. Anything that needs `sudo -S` or `vipw` won't
   work.
