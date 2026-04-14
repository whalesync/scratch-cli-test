# Docker Desktop Disk Monitor (macOS)

A LaunchAgent that alerts when Docker Desktop's internal VM disk gets full. Useful for anyone running the local GitLab runner (see [local-gitlab-runner.md](../local-gitlab-runner.md)) or otherwise relying on Docker for builds.

## Why

Docker Desktop allocates a fixed-size virtual disk inside its VM, separate from your Mac's filesystem. When that VM disk fills up, containers start hitting obscure errors — most notably, `apt-get update` reports `"At least one invalid signature was encountered"` rather than a disk-full error, which makes it very hard to diagnose. Stale images, build cache, and unused volumes accumulate silently until a CI job or dev command breaks.

This monitor runs every 30 minutes, checks the VM's overlay filesystem via a throwaway `alpine` container, and fires a macOS notification when usage crosses a threshold (default 90%).

## Install

From the repo root:

```bash
# 1. Copy the script to a stable location and make it executable.
mkdir -p ~/.local/bin
cp docs/ops/local-dev/docker-disk-check.sh ~/.local/bin/
chmod +x ~/.local/bin/docker-disk-check.sh

# 2. Copy the LaunchAgent plist, substituting your home directory.
sed "s|__HOME__|$HOME|g" docs/ops/local-dev/com.spinner.docker-disk-check.plist \
  > ~/Library/LaunchAgents/com.spinner.docker-disk-check.plist

# 3. Load it (runs once immediately, then every 30 minutes).
launchctl load ~/Library/LaunchAgents/com.spinner.docker-disk-check.plist

# 4. Verify it's registered.
launchctl list | grep docker-disk-check
```

The first run happens at load time. Check `~/Library/Logs/docker-disk-check.log` to confirm — you should see a line like `Docker VM overlay disk at 45%`.

## Notification permissions

`osascript` notifications on macOS are delivered through **Script Editor**. The first time the script fires an alert, macOS may silently drop it. To allow future alerts through:

1. Trigger a one-time test notification:
   ```bash
   osascript -e 'display notification "test" with title "Docker disk alert"'
   ```
2. Open **System Settings → Notifications → Script Editor** and set alerts to **Banners** or **Alerts**.

## When an alert fires

The notification says:

> Docker Desktop VM disk is 94% full. Run: `docker system prune -a --volumes`

That command reclaims stopped containers, unused images, build cache, and dangling volumes. If you also run the local GitLab runner, stop it first so it doesn't hold references:

```bash
gitlab-runner stop
docker system prune -a --volumes
gitlab-runner start
```

Repeat alerts are suppressed for 6 hours after the first one, so you won't get spammed while you clean up.

## Customize

Edit `~/.local/bin/docker-disk-check.sh`:

- `THRESHOLD=90` — the usage percentage that fires an alert.

Edit `~/Library/LaunchAgents/com.spinner.docker-disk-check.plist`:

- `StartInterval` — seconds between checks (default 1800 = 30 min).

After editing the plist, reload it:

```bash
launchctl unload ~/Library/LaunchAgents/com.spinner.docker-disk-check.plist
launchctl load ~/Library/LaunchAgents/com.spinner.docker-disk-check.plist
```

## Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/com.spinner.docker-disk-check.plist
rm ~/Library/LaunchAgents/com.spinner.docker-disk-check.plist
rm ~/.local/bin/docker-disk-check.sh
rm -f ~/Library/Caches/docker-disk-check.last-alert
rm -f ~/Library/Logs/docker-disk-check.log ~/Library/Logs/docker-disk-check.stdout.log ~/Library/Logs/docker-disk-check.stderr.log
```

## Troubleshooting

**No notifications appear when usage is high.** Check Script Editor notification permissions (see above) and look at `~/Library/Logs/docker-disk-check.log` — if it says `ALERT fired at X%` but you saw nothing, it's a permissions issue. If the log shows `alert suppressed`, delete the state file: `rm ~/Library/Caches/docker-disk-check.last-alert`.

**Log says `docker daemon not running`.** Expected whenever Docker Desktop is closed — the script skips silently.

**Log says `could not parse disk usage`.** The `alpine` container couldn't run or `df` output format changed. Run the script manually (`~/.local/bin/docker-disk-check.sh`) to see what happened; check `~/Library/Logs/docker-disk-check.stderr.log`.

**I want to test the alert without filling the disk.** Temporarily set `THRESHOLD=1` in the script, run it manually, then revert. Delete the state file between test runs.
