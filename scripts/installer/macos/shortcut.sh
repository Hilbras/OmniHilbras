#!/usr/bin/env bash
#
# Put `omnihilbras` on PATH on macOS, and take it away again.
#
# ## Why this is a script rather than part of the installer
#
# The Windows installer can run a command after copying the app (NSIS `customInstall`), and the Linux
# `.deb` gets the same for free from electron-builder's `after-install` — it registers
# `/usr/bin/omnihilbras` as an update-alternative. A `.dmg` has no post-install hook at all: it is a disk
# image with an application in it, and nothing runs on the way out. So on macOS the choice is a `.pkg`
# (which needs a signing identity and an installer UI) or this: one command the person runs once, which is
# also the only one of the three that tells them exactly what it changed.
#
# ## Usage
#
#   bash scripts/installer/macos/shortcut.sh --install     # add the command
#   bash scripts/installer/macos/shortcut.sh --uninstall   # remove it again
#   bash scripts/installer/macos/shortcut.sh --install --app /path/to/OmniHilbras.app
#
# Exit codes: 0 done, 1 could not (see the message), 2 usage error.

set -u

ACTION=""
APP_PATH="/Applications/OmniHilbras.app"
LINK="/usr/local/bin/omnihilbras"

while [ $# -gt 0 ]; do
  case "$1" in
    --install) ACTION="install" ;;
    --uninstall) ACTION="uninstall" ;;
    --app) shift; APP_PATH="${1:-}" ;;
    --link) shift; LINK="${1:-}" ;;
    --help|-h) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

[ -n "$ACTION" ] || { echo "Specify --install or --uninstall (try --help)." >&2; exit 2; }

BINARY="$APP_PATH/Contents/MacOS/OmniHilbras"

if [ "$ACTION" = "install" ]; then
  if [ ! -x "$BINARY" ]; then
    echo "Cannot find the application binary at:" >&2
    echo "  $BINARY" >&2
    echo "Install the app first, or point at it with --app /path/to/OmniHilbras.app." >&2
    exit 1
  fi

  # Never overwrite something that is not ours. `omnihilbras` may already be a link to a globally installed
  # npm client, and replacing it would silently remove that one — the same mistake the Linux deb's
  # generated script makes when it deletes a non-alternatives link it finds.
  if [ -e "$LINK" ] || [ -L "$LINK" ]; then
    EXISTING="$(readlink "$LINK" 2>/dev/null || echo "")"
    if [ "$EXISTING" = "$BINARY" ]; then
      echo "Already installed: $LINK → $BINARY"
      exit 0
    fi
    echo "Refusing to replace $LINK — it already exists and is not this app:" >&2
    echo "  it points at: ${EXISTING:-$(ls -ld "$LINK" 2>/dev/null)}" >&2
    echo "Remove it yourself if you want the app's shortcut instead." >&2
    exit 1
  fi

  if [ -w "$(dirname "$LINK")" ]; then
    ln -s "$BINARY" "$LINK"
  else
    # /usr/local/bin usually exists and is root-owned; `sudo -n` fails rather than prompting when a password
    # would be needed, which is what makes this safe to run from a script.
    echo "Creating $LINK needs administrator rights."
    sudo ln -s "$BINARY" "$LINK" || { echo "Could not create $LINK." >&2; exit 1; }
  fi
  echo "Installed: $LINK → $BINARY"
  echo "Open a new terminal and run: omnihilbras setup"
  exit 0
fi

# --uninstall
if [ ! -L "$LINK" ]; then
  echo "Nothing to remove: $LINK is not a symlink."
  exit 0
fi

TARGET="$(readlink "$LINK")"
if [ "$TARGET" != "$BINARY" ]; then
  echo "Not removing $LINK — it points at $TARGET, not at this app."
  exit 0
fi

if [ -w "$(dirname "$LINK")" ]; then
  rm -f "$LINK"
else
  sudo rm -f "$LINK" || { echo "Could not remove $LINK." >&2; exit 1; }
fi
echo "Removed: $LINK"
exit 0
