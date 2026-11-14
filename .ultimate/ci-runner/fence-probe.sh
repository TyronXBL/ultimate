#!/bin/bash
# What the runner user on the PC can read and reach (README.md here, "Fence the runner user in"). Run it on the PC as
# `ci`, through the runner itself, before `remoteJobs.host` is set on the VPS:
#
#   ULTIMATE_REMOTE_HOST=my-pc ULTIMATE_REMOTE_STATUS=$TMPDIR/probe.json \
#     ULTIMATE_REMOTE_COMMAND='bash .ultimate/ci-runner/fence-probe.sh <the VPS tailnet address>' \
#     node .ultimate/scripts/remote-job.ts
#
# It prints states only, never a name or an address, and exits 1 when a fence is missing.
failed=()
say() { echo "fence-probe: $*"; }
# Whether a TCP connection to host $1 port $2 opens within 3 s.
opens() { timeout 3 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; }

sudo -n true >/dev/null 2>&1 && failed+=("sudo works without a password")
[[ -w /usr/local/bin/ultimate-ci ]] && failed+=("the runner script is writable by this user")
[[ -w /etc/ssh/authorized_keys/$(id -un) ]] && failed+=("the key file is writable by this user")

for dir in /home/*; do
  [[ $dir == "$HOME" ]] && continue
  if ls "$dir" >/dev/null 2>&1; then
    say "another user's home (mode $(stat -c %a "$dir")) is READABLE"
    failed+=("another user's home is readable")
  else
    say "another user's home (mode $(stat -c %a "$dir")) is not readable"
  fi
done

gateway=$(ip route show default 2>/dev/null | awk '{print $3; exit}')
for target in ${gateway:+"LAN gateway:$gateway:80" "LAN gateway:$gateway:443" "LAN gateway:$gateway:53"} \
  ${1:+"tailnet peer:$1:22"}; do
  IFS=: read -r name host port <<<"$target"
  if opens "$host" "$port"; then
    say "$name port $port is OPEN"
    failed+=("$name port $port can be reached")
  else
    say "$name port $port is closed or filtered"
  fi
done
[[ -n $gateway ]] || say "no default gateway found: the LAN was not tried"
[[ -n ${1:-} ]] || say "no tailnet address given: the tailnet was not tried"

# Installs need the package registry; without it a changed lockfile sends every job back to the VPS.
if opens registry.npmjs.org 443; then say "the package registry can be reached"; else say "the package registry CANNOT be reached"; fi

if ((${#failed[@]})); then
  say "FAILED: $(
    IFS=';'
    echo "${failed[*]}"
  )"
  exit 1
fi
say "ok: this user reads no other home and reaches neither the LAN nor the tailnet"
