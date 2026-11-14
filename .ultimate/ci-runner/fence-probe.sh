#!/bin/bash
# What a user on the PC can read and reach (README.md here, "Fence the runner user in"):
#
#   fence-probe.sh <tailnet address> <port>
#
# The address and port are a service on the tailnet that answers other machines, such as the VPS's own HTTPS port. It
# exits 0 only when the user has no sudo, cannot write the runner script or its key file, cannot enter another user's
# home, and reaches neither the LAN's gateway nor that tailnet service; 1 while one of them does not hold or could
# not be tried. It prints states only, never a name or an address.
#
# A connection that fails proves a fence only when the same connection opens without it. So the PC's owner runs the
# probe first as themselves, where it must fail with "can be reached" lines: those targets answer. Then the VPS runs
# it as `ci`, through the runner, before `remoteJobs.host` is set:
#
#   ULTIMATE_REMOTE_HOST=my-pc ULTIMATE_REMOTE_STATUS=$TMPDIR/probe.json \
#     ULTIMATE_REMOTE_COMMAND='bash .ultimate/ci-runner/fence-probe.sh <tailnet address> <port>' \
#     node .ultimate/scripts/remote-job.ts
if [[ $# -ne 2 ]]; then
  echo "fence-probe: usage: fence-probe.sh <tailnet address> <port>" >&2
  exit 2
fi
failed=()
say() { echo "fence-probe: $*"; }
# Whether a TCP connection to host $1 port $2 opens within 3 s.
opens() { timeout 3 bash -c 'exec 3<>"/dev/tcp/$0/$1"' "$1" "$2" 2>/dev/null; }
# A service this user must not reach: $1 names it, $2 and $3 are its host and port.
unreachable() {
  if opens "$2" "$3"; then
    say "$1 port $3 is OPEN"
    failed+=("$1 port $3 can be reached")
  else
    say "$1 port $3 is closed or filtered"
  fi
}

sudo -n true >/dev/null 2>&1 && failed+=("sudo works without a password")
[[ -w /usr/local/bin/ultimate-ci ]] && failed+=("the runner script is writable by this user")
[[ -w /etc/ssh/authorized_keys/$(id -un) ]] && failed+=("the key file is writable by this user")

# Entering counts, not only listing: files in a home that can be entered are read by their path.
for dir in /home/*; do
  [[ $dir == "$HOME" ]] && continue
  if [[ -r $dir || -x $dir || -w $dir ]]; then
    say "another user's home (mode $(stat -c %a "$dir")) can be entered or read"
    failed+=("another user's home can be entered or read")
  else
    say "another user's home (mode $(stat -c %a "$dir")) is closed to this user"
  fi
done

gateway=$(ip route show default 2>/dev/null | awk '{print $3; exit}')
if [[ -z $gateway ]]; then
  failed+=("no default gateway was found, so the LAN could not be tried")
else
  for port in 80 443 53; do unreachable "LAN gateway" "$gateway" "$port"; done
  if ! command -v ping >/dev/null; then
    say "ping is not installed: the LAN gateway was tried over TCP only"
  elif ping -c 1 -W 2 "$gateway" >/dev/null 2>&1; then
    say "LAN gateway answers a ping"
    failed+=("the LAN gateway can be pinged")
  else
    say "LAN gateway answers no ping"
  fi
fi
unreachable "tailnet service" "$1" "$2"

# Installs need the package registry; without it a changed lockfile sends every job back to the VPS.
if opens registry.npmjs.org 443; then
  say "the package registry can be reached"
else
  say "the package registry CANNOT be reached"
fi

if ((${#failed[@]})); then
  say "FAILED: $(
    IFS=';'
    echo "${failed[*]}"
  )"
  exit 1
fi
say "ok: this user enters no other home and reaches neither the LAN gateway nor the tailnet service"
