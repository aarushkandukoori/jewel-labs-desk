#!/bin/bash
# Installs Jewel Labs on a Mac from Terminal:
#
#   curl -fsSL https://aarushkandukoori.github.io/jewel-labs-desk/install.sh | bash
#
# Why this exists: the app is not notarized by Apple yet, so a .dmg downloaded in a browser gets the
# "Apple could not verify ... is free of malware" message. A file fetched with curl is not marked as
# downloaded from the internet, so the app this script installs opens without that message.
#
# What it does: picks the Apple silicon or Intel installer, downloads it from the latest GitHub release
# into a temporary folder, checks it against the checksum the release publishes (latest-mac.yml),
# copies the app into /Applications (or ~/Applications when /Applications is not writable), and opens it.
# It never uses sudo and never changes a security setting. It writes only to the temporary folder and
# the install folder.
#
# Test switches (so the script can be tried without touching /Applications):
#   JL_INSTALL_DIR=/some/folder   install there instead
#   JL_DMG_FILE=/path/to.dmg      use this disk image instead of downloading one
#   JL_LATEST_YML=/path/to.yml    check against this file instead of the release's latest-mac.yml
#   JL_NO_OPEN=1                  do not open the app at the end
#
# Everything is inside main, called on the last line, so a download cut short runs nothing.

set -euo pipefail

RELEASE_URL="https://github.com/aarushkandukoori/jewel-labs-desk/releases/latest/download"
APP_NAME="Jewel Labs.app"
WORK_DIR=""
MOUNT_DIR=""

say() { printf '%s\n' "$*"; }
fail() { printf 'Jewel Labs install stopped: %s\n' "$*" >&2; exit 1; }

# Unmounts the disk image and deletes the temporary folder, on every way out.
cleanup() {
  if [ -n "$MOUNT_DIR" ] && [ -d "$MOUNT_DIR" ]; then
    hdiutil detach "$MOUNT_DIR" -quiet >/dev/null 2>&1 || hdiutil detach "$MOUNT_DIR" -force -quiet >/dev/null 2>&1 || true
  fi
  if [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ]; then
    rm -rf "${WORK_DIR:?}" 2>/dev/null || true
  fi
}

# arm64 on Apple silicon, also when Terminal itself runs under Rosetta; x64 on Intel.
pick_arch() {
  local translated
  translated="$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)"
  if [ "$(uname -m)" = "arm64" ] || [ "$translated" = "1" ]; then echo arm64; else echo x64; fi
}

# The folder to install into: the test switch, else /Applications when we may write there, else ~/Applications.
pick_install_dir() {
  if [ -n "${JL_INSTALL_DIR:-}" ]; then echo "$JL_INSTALL_DIR"
  elif [ -w /Applications ]; then echo /Applications
  else echo "$HOME/Applications"
  fi
}

# The sha512 (base64) that latest-mac.yml lists for one file name. Prints nothing when it is not listed.
expected_sha512() {
  local yml="$1" name="$2"
  awk -v name="$name" '
    $1 == "-" && $2 == "url:" { current = $3 }
    $1 == "url:" { current = $2 }
    $1 == "sha512:" && current == name { print $2; exit }
  ' "$yml"
}

# Downloads the installer and its checksum, and stops when they do not match.
download_and_check() {
  local dmg_name="$1" dmg="$2" yml="$WORK_DIR/latest-mac.yml"
  curl -fL --progress-bar -o "$dmg" "$RELEASE_URL/$dmg_name" || fail "could not download $dmg_name. Check the internet connection and try again."
  if [ -n "${JL_LATEST_YML:-}" ]; then
    yml="$JL_LATEST_YML"
  else
    curl -fsSL -o "$yml" "$RELEASE_URL/latest-mac.yml" || fail "could not download the release checksum (latest-mac.yml)."
  fi
  say "Checking the download..."
  check_sha512 "$dmg" "$dmg_name" "$yml"
}

# Compares the file's sha512 with the one in latest-mac.yml.
check_sha512() {
  local dmg="$1" dmg_name="$2" yml="$3" want got
  want="$(expected_sha512 "$yml" "$dmg_name")"
  [ -n "$want" ] || fail "the release checksum does not list $dmg_name."
  got="$(openssl dgst -sha512 -binary "$dmg" | base64 | tr -d '\n')"
  [ "$got" = "$want" ] || fail "the downloaded $dmg_name does not match the release checksum. Nothing was installed. Try again later."
}

# Asks a running copy of the installed app to quit, and waits up to 15 seconds for it.
quit_running_copy() {
  local app="$1" i
  pgrep -f "$app/Contents/MacOS/" >/dev/null 2>&1 || return 0
  say "Quitting the running Jewel Labs..."
  osascript -e "tell application \"$app\" to quit" >/dev/null 2>&1 || true
  for i in $(seq 1 15); do
    pgrep -f "$app/Contents/MacOS/" >/dev/null 2>&1 || return 0
    sleep 1
  done
  fail "Jewel Labs is still open. Quit it and run this again."
}

# Copies the app from the mounted image, next to the old copy first, then swaps it in.
install_app() {
  local source="$1" dest_dir="$2" target="$2/$APP_NAME" staged="$2/.Jewel Labs.app.installing"
  mkdir -p "$dest_dir" || fail "could not make $dest_dir."
  [ -w "$dest_dir" ] || fail "cannot write to $dest_dir."
  rm -rf "${staged:?}"
  ditto "$source" "$staged" || fail "could not copy the app into $dest_dir."
  if [ -e "$target" ]; then
    rm -rf "${target:?}" || { rm -rf "${staged:?}"; fail "could not replace the old copy in $dest_dir. Move it to the Trash and run this again."; }
  fi
  mv "$staged" "$target"
}

main() {
  [ "$(uname -s)" = "Darwin" ] || fail "this installer is for macOS. On Windows, download the installer from https://aarushkandukoori.github.io/jewel-labs-desk/"

  local arch dmg_name dmg dest_dir target version
  arch="$(pick_arch)"
  dmg_name="Jewel-Labs-mac-$arch.dmg"
  dest_dir="$(pick_install_dir)"
  target="$dest_dir/$APP_NAME"

  WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/jewel-labs-install.XXXXXX")"
  trap cleanup EXIT
  trap 'exit 130' INT TERM

  if [ -n "${JL_DMG_FILE:-}" ]; then
    [ -f "$JL_DMG_FILE" ] || fail "no disk image at $JL_DMG_FILE."
    dmg="$JL_DMG_FILE"
    say "Using the local disk image $dmg"
    if [ -n "${JL_LATEST_YML:-}" ]; then
      say "Checking the disk image..."
      check_sha512 "$dmg" "$dmg_name" "$JL_LATEST_YML"
    fi
  else
    dmg="$WORK_DIR/$dmg_name"
    say "Downloading Jewel Labs for $([ "$arch" = arm64 ] && echo 'Apple silicon' || echo 'Intel')..."
    download_and_check "$dmg_name" "$dmg"
  fi

  MOUNT_DIR="$WORK_DIR/mount"
  mkdir -p "$MOUNT_DIR"
  hdiutil attach -readonly -nobrowse -noautoopen -quiet -mountpoint "$MOUNT_DIR" "$dmg" || fail "could not open the disk image."
  [ -d "$MOUNT_DIR/$APP_NAME" ] || fail "the disk image has no $APP_NAME inside."

  quit_running_copy "$target"
  say "Installing into $dest_dir..."
  install_app "$MOUNT_DIR/$APP_NAME" "$dest_dir"

  version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$target/Contents/Info.plist" 2>/dev/null || echo '')"
  if [ "${JL_NO_OPEN:-}" = "1" ]; then
    say "Done. Jewel Labs ${version} is in $dest_dir."
  else
    say "Done. Opening Jewel Labs ${version}."
    open "$target"
  fi
}

main "$@"
