#!/bin/sh
set -eu
umask 077

fail() { printf '%s\n' "$1" >&2; exit 1; }
[ "$(/usr/bin/uname -s)" = Darwin ] || fail 'This installer runs only inside the owned macOS guest.'
[ "$(/usr/bin/uname -m)" = arm64 ] || fail 'The guest must be Apple silicon macOS.'
[ "$(/usr/sbin/sysctl -n kern.hv_vmm_present 2>/dev/null || printf 0)" = 1 ] || fail 'Refusing a non-VM system. Do not run this installer on the host.'
uid=$(/usr/bin/id -u)
gid=$(/usr/bin/id -g)
[ "$uid" -ne 0 ] || fail 'Run as the logged-in guest user, not with sudo. Guest administrator authorization is used only for the owned mount service.'
case "${1-}" in
  '') install_browser=0 ;;
  --install-browser) install_browser=1 ;;
  *) fail 'Usage: sh /Volumes/QAutraKit/setup-guest.sh [--install-browser]' ;;
esac
[ "$#" -le 1 ] || fail 'Unexpected arguments.'
[ -d /Volumes/QAutraKit ] && [ ! -L /Volumes/QAutraKit ] || fail 'Mount the private read-only QAutraKit virtiofs share first; see GuestSetup.txt.'
[ -x /Volumes/QAutraKit/QAutraGuestAgent.app/Contents/MacOS/QAutraGuestAgent ] || fail 'The signed guest application is missing from QAutraKit.'

if [ ! -d /Volumes/QAutraStatus ]; then
  /usr/bin/sudo /bin/mkdir -m 755 /Volumes/QAutraStatus
fi
[ ! -L /Volumes/QAutraStatus ] || fail 'Refusing a symlink mount point.'
if ! /sbin/mount | /usr/bin/grep -Fq ' on /Volumes/QAutraStatus ('; then
  /usr/bin/sudo /sbin/mount_virtiofs -u "$uid" -g "$gid" QAutraStatus /Volumes/QAutraStatus
fi

source_agent=/Volumes/QAutraKit/QAutraGuestAgent.app/Contents/MacOS/QAutraGuestAgent
"$source_agent" --verify-kit

mount_root='/Library/Application Support/QAutraGuestMounts'
mount_job='/Library/LaunchDaemons/com.qautra.guest-mounts.plist'
for destination in "$mount_root" "$mount_job"; do
  [ ! -e "$destination" ] && [ ! -L "$destination" ] || fail 'An existing guest mount service must be inspected; it will not be adopted or overwritten.'
done
/usr/bin/sudo /bin/mkdir -m 755 "$mount_root"
/usr/bin/sudo /usr/bin/tee "$mount_root/mount-shares.sh" >/dev/null <<'MOUNTS'
#!/bin/sh
set -eu
[ "$(/usr/sbin/sysctl -n kern.hv_vmm_present)" = 1 ] || exit 1
[ "$#" -eq 2 ] || exit 1
case "$1:$2" in *[!0-9:]*|:|0:*) exit 1 ;; esac
for tag in QAutraKit QAutraStatus; do
  target="/Volumes/$tag"
  [ ! -L "$target" ] || exit 1
  if [ ! -d "$target" ]; then /bin/mkdir -m 755 "$target"; fi
  if /sbin/mount | /usr/bin/grep -Fq " on $target ("; then continue; fi
  if [ "$tag" = QAutraKit ]; then
    /sbin/mount_virtiofs -r -u "$1" -g "$2" "$tag" "$target"
  else
    /sbin/mount_virtiofs -u "$1" -g "$2" "$tag" "$target"
  fi
done
MOUNTS
/usr/bin/sudo /bin/chmod 700 "$mount_root/mount-shares.sh"
/usr/bin/sudo /usr/bin/tee "$mount_job" >/dev/null <<MOUNT_JOB
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.qautra.guest-mounts</string>
  <key>ProgramArguments</key><array>
    <string>$mount_root/mount-shares.sh</string><string>$uid</string><string>$gid</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
</dict></plist>
MOUNT_JOB
/usr/bin/sudo /bin/chmod 644 "$mount_job"
/usr/bin/sudo /bin/launchctl bootstrap system "$mount_job"

"$source_agent" --install-user
installed_agent="$HOME/Library/Application Support/QAutraGuest/QAutraGuestAgent.app/Contents/MacOS/QAutraGuestAgent"
[ -x "$installed_agent" ] || fail 'Guest installation did not produce its private executable.'
if [ "$install_browser" -eq 1 ]; then
  "$installed_agent" --install-browser
fi
platform=$("$installed_agent" --platform)
if [ "$platform" = desktop-safari ]; then
  printf '%s\n' 'Safari automation must be authorized INSIDE THIS GUEST before the first session.' 'In guest Safari, enable the Develop menu and Develop > Allow Remote Automation.' 'If guest macOS requires it, run sudo /usr/bin/safaridriver --enable in the guest Terminal and approve the guest administrator prompt.' 'No Safari settings, TCC grants, or host settings were changed by this installer.'
fi
/bin/launchctl bootstrap "gui/$uid" "$HOME/Library/LaunchAgents/com.qautra.guest-agent.plist"
printf '%s\n' 'The guest user LaunchAgent was submitted. Connection is not browser readiness; only an actual successful W3C session establishes browser readiness.'
