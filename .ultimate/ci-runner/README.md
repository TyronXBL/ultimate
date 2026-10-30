# PC runner

A Windows PC on the tailnet runs the test suites first, before GitHub Actions. It runs them for the lander's gate
(`.ultimate/scripts/ci-gate.ts`, `pnpm test` then `pnpm test:e2e`) and for the `ci` tool (`pnpm check`, `pnpm test`,
then `pnpm test:e2e`). The suites run one after the other, and the PC runs one run at a time.

A run goes like this:

1. The VPS pushes the commit into the PC's bare `~/ci.git`.
2. `ssh ultimate-ci run <sha> <suite>…` runs [`ultimate-ci`](ultimate-ci) in a fresh worktree there, and the output streams back.

The PC's answer decides what happens next:

- **Passed or failed:** that verdict is the result.
- **No verdict** (unreachable, asleep, busy, install failed): the run goes to GitHub Actions at once.
- **No `pc` remote on the VPS:** the PC is never tried.

The code is in `.ultimate/extensions/ci/pc.ts`.

## How it is set up

- **The distro:** a dedicated WSL2 distro, `ultimate-ci`. Windows programs, the Windows drive and sudo are off in it.
- **The network:** the Windows Tailscale client plus mirrored networking.
- **sshd** listens on port 2222. A Hyper-V firewall rule admits only the VPS's tailnet address.
- **The key:** the VPS's key can run only `ultimate-ci`. That script either receives commits into `~/ci.git`, or runs
  `check`, `test` or `test:e2e` for one commit.
- **No secrets** live on the PC; it never needs GitHub access.

Know what "only test runs" means: a test run executes the commit's code. So the VPS can run any code as the
unprivileged `ci` user inside the distro. What contains it is the locked-down distro, not the forced command. A run
may take up to 15 minutes for the lander and 30 minutes for the `ci` tool; after that, GitHub runs it.

That code can also reach your LAN and the tailnet: no outbound filter limits the `ci` user.

## Who does what

- 🪟 You, on Windows (an admin PowerShell where it says so).
- 🐧 You, as root in the `ultimate-ci` distro (`wsl -d ultimate-ci -u root`).
- 🤖 @ultimate, on the VPS.

The key lets @ultimate only push commits and start runs. Every change to the PC stays in your hands.

## 1. The distro and WSL settings 🪟

Mirrored networking needs Windows 11 22H2 or newer; check with `winver`.

```powershell
wsl --update
wsl --install archlinux --name ultimate-ci
```

`C:\Users\<you>\.wslconfig` applies to every distro:

```ini
[wsl2]
networkingMode=mirrored
memory=24GB
processors=14
swap=8GB
```

Then run `wsl --shutdown` so it takes effect.

## 2. Lock down the distro 🐧

`/etc/wsl.conf`:

```ini
[boot]
systemd=true

[interop]
enabled=false
appendWindowsPath=false

[automount]
enabled=false
mountFsTab=false

[network]
hostname=ultimate-ci
```

Restart the distro (`wsl --terminate ultimate-ci` 🪟) and open it as root again.

Without these settings, any Linux user in the distro could start Windows programs as your Windows user and read your
drives.

## 3. Packages 🐧

These are the same packages the VPS runs the suites with. The e2e tests find Chromium at `/usr/bin/chromium`.

```bash
pacman -Syu --needed base-devel git nodejs npm pnpm chromium openssh ripgrep fd jq
node --version     # v26.x
```

You don't need corepack: Arch's `pnpm` switches to the version the repository pins.

## 4. The runner user 🐧

```bash
useradd -m -u 61000 -s /bin/bash ci && passwd -l ci     # no password, no sudo
sudo -u ci git init -q --bare /home/ci/ci.git
sudo -u ci git -C /home/ci/ci.git config receive.fsckObjects true
sudo -u ci git config --global user.name CI
sudo -u ci git config --global user.email ci@example.com
```

Everything lives in `/home/ci`, on the distro's Linux filesystem.

## 5. The runner script 🐧

Copy [`ultimate-ci`](ultimate-ci) from this folder to `/usr/local/bin/ultimate-ci`, so `ci` can run it but not change it:

```bash
install -o root -g root -m 755 ultimate-ci /usr/local/bin/ultimate-ci
```

## 6. sshd on port 2222 🐧

`/etc/ssh/sshd_config.d/ultimate-ci.conf`:

```
Port 2222
AllowUsers ci
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no

# Root owns the key file and the command, outside the home that test code can write to.
Match User ci
  AuthorizedKeysFile /etc/ssh/authorized_keys/%u
  ForceCommand /usr/local/bin/ultimate-ci
  DisableForwarding yes
  PermitTTY no
  PermitUserRC no
```

```bash
systemctl enable --now sshd
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

Send @ultimate the fingerprint the last command prints. It checks it against the key it sees before trusting the PC.

## 7. The VPS's key 🤖 then 🐧

🤖 @ultimate creates `~/.ssh/ultimate-ci` on the VPS and sends you only its public line. The private key never leaves
the VPS.

🐧 Put the line in `/etc/ssh/authorized_keys/ci`, prefixed like this (sshd's `ForceCommand` from step 6 applies
either way):

```
restrict,command="/usr/local/bin/ultimate-ci" ssh-ed25519 AAAA… ultimate@my-vps
```

```bash
mkdir -p /etc/ssh/authorized_keys && chmod 755 /etc/ssh/authorized_keys
chown root:root /etc/ssh/authorized_keys/ci && chmod 644 /etc/ssh/authorized_keys/ci
systemctl reload sshd
```

Test code runs as `ci`, so nothing that decides what the key may do lives where `ci` can write.

## 8. Let only the VPS in 🪟 (admin PowerShell)

Find the VPS's tailnet address with `tailscale ip -4 <vps>` or in the Tailscale admin console:

```powershell
New-NetFirewallHyperVRule -Name ultimate-ci-ssh -DisplayName "ultimate-ci ssh" -Direction Inbound `
  -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -Protocol TCP -LocalPorts 2222 `
  -RemoteAddresses <VPS tailnet IP>
```

In the Windows Tailscale client, leave "Allow incoming connections" on.

## 9. Keep it awake 🪟

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```

The screen may still turn off. WSL stops an idle distro, so start it hidden at logon and keep it running. Save this as
`ultimate-ci.vbs` in the folder `shell:startup` opens:

```vb
CreateObject("WScript.Shell").Run "wsl.exe -d ultimate-ci --exec /usr/bin/sleep infinity", 0
```

Until you log in after a reboot the PC is unreachable, and runs go to GitHub.

## 10. Connect and time a run 🤖

`~/.ssh/config` on the VPS:

```
Host ultimate-ci
  HostName my-pc.<tailnet>.ts.net
  Port 2222
  User ci
  IdentityFile ~/.ssh/ultimate-ci
  IdentitiesOnly yes
  BatchMode yes
  StrictHostKeyChecking yes
  ConnectTimeout 5
  ServerAliveInterval 15
  ServerAliveCountMax 4
```

Once the user confirms the fingerprint from step 6:

```bash
ssh-keyscan -p 2222 -t ed25519 my-pc.<tailnet>.ts.net > /tmp/pc-key
ssh-keygen -lf /tmp/pc-key                   # must match step 6
cat /tmp/pc-key >> ~/.ssh/known_hosts
ssh ultimate-ci bash; echo $?                # refused: exit 2
git -C /opt/ultimate remote add pc ultimate-ci:ci.git
cd <a checkout> && git push -q pc HEAD:refs/heads/run/$(git rev-parse HEAD)
time ssh ultimate-ci run $(git rev-parse HEAD) test test:e2e
```

To take the PC out of the pipeline, run `git -C /opt/ultimate remote remove pc`.
