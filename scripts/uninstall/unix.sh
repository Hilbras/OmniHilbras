#!/usr/bin/env bash
#
# Uninstall OmniHilbras from this machine — **every** version of it.
#
# ## Why this exists
#
# `npm rm -g @hilbras/omnihilbras` removes the package and nothing else. It leaves the vault, the
# per-launch dashboard token, the state directory the launcher writes its process group into, any desktop
# application directory, an autostart entry, and — the one that keeps confusing people — a copy of the
# binary on `PATH` that npm no longer knows about, which still answers `omnihilbras --version` after the
# uninstall and makes it look like nothing happened.
#
# Older copies make that worse: this project has shipped under more than one name and version, and `npm rm`
# only removes the name you happen to type.
#
# ## What it does, in order
#
#   1. Finds everything, and prints it. Nothing is removed before you have seen the list.
#   2. Removes the npm packages (every name, every version) and any leftover PATH binary.
#   3. Removes application directories and autostart entries.
#   4. **Leaves your data alone** — the vault, the keys, the token — unless `--purge-data` says otherwise.
#
# ## Flags
#
#   --dry-run      print what would be removed, remove nothing (also what happens without a terminal)
#   --purge-data   also remove the vault and configuration (credentials live there; read the warning)
#   --yes          do not ask for confirmation
#   --help         this text
#
# Environment: OMNIHILBRAS_UNINSTALL_SKIP_SYSTEM=1 leaves /opt and /usr/lib alone (user-scope installs).
#
# Exit codes: 0 done (or nothing to do), 1 something could not be removed, 2 usage error, 130 cancelled.

set -u

DRY_RUN=0
PURGE_DATA=0
ASSUME_YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --purge-data) PURGE_DATA=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --help|-h) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; OFF=$'\033[0m'
else
  BOLD=''; DIM=''; RED=''; GREEN=''; YELLOW=''; OFF=''
fi

HOME_DIR="${HOME:?HOME is not set; refusing to guess where to uninstall from}"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME_DIR/.config}"
STATE_DIR="${XDG_STATE_HOME:-$HOME_DIR/.local/state}"
DATA_DIR="${XDG_DATA_HOME:-$HOME_DIR/.local/share}"

# Every name this project has shipped under. The version is not part of the decision: an old 2.9.x and a
# current 3.x install the same command and fight over the same ports, so both go.
PACKAGE_NAMES=("@hilbras/omnihilbras" "omnihilbras")

# Application directories: where an installed app lives, as opposed to where its data lives.
#
# The system-wide ones need root, and a user who installed under their home does not have them at all.
# `OMNIHILBRAS_UNINSTALL_SKIP_SYSTEM=1` leaves them out — which is what a user-scope uninstall wants, and
# what makes this script testable against a fake home instead of whatever happens to be in /opt.
APP_DIRS=(
  "$HOME_DIR/.local/opt/OmniHilbras"
)
if [ "${OMNIHILBRAS_UNINSTALL_SKIP_SYSTEM:-0}" != "1" ]; then
  APP_DIRS+=("/opt/OmniHilbras" "/usr/lib/omnihilbras")
fi

# Data directories: the vault lives in the first of these. Never removed without --purge-data.
DATA_DIRS=(
  "$HOME_DIR/.omnihilbras"
  "$CONFIG_DIR/omnihilbras"
  "$STATE_DIR/omnihilbras"
  "$DATA_DIR/omnihilbras"
)

AUTOSTART_FILES=(
  "$CONFIG_DIR/autostart/omnihilbras.desktop"
)

PROBLEMS=0
REMOVED=0

say()  { printf '%s\n' "$*"; }
step() { printf '\n%s%s%s\n' "$BOLD" "$*" "$OFF"; }
note() { printf '%s%s%s\n' "$DIM" "$*" "$OFF"; }

# A path is only "present" if it actually is, so the report cannot claim to have removed something that
# was never there — the failure mode that makes people distrust an uninstaller.
present() { [ -e "$1" ] || [ -L "$1" ]; }

remove_path() {
  local target="$1"
  if ! present "$target"; then return 0; fi
  if [ "$DRY_RUN" = 1 ]; then
    say "  ${YELLOW}would remove${OFF} $target"
    return 0
  fi
  # `rm -rf` on a container is how an uninstaller deletes a home directory or a system tree. The guard is a
  # denylist of the containers this project could ever name as a *parent*, not an allowlist of one prefix:
  # an allowlist of `$HOME/*` refused every legitimate system target — `/opt/OmniHilbras`, a leftover in
  # `/usr/bin` — and reported them as problems, which made a correct uninstall look broken.
  #
  # The first arm refuses; everything else falls through to the removal below. Getting that the wrong way
  # round refuses every real target and silently does nothing for the catastrophic ones, which is how this
  # read the first time it was written.
  case "$target" in
    /|/usr|/usr/bin|/usr/lib|/usr/local|/usr/share|/bin|/sbin|/etc|/var|/var/lib|/opt|/tmp|/Applications|"$HOME_DIR"|"$CONFIG_DIR"|"$STATE_DIR"|"$DATA_DIR")
      say "  ${RED}refusing to remove${OFF} $target ${DIM}(it is a container directory, not an installation)${OFF}"
      PROBLEMS=1
      return 1
      ;;
    *) ;;
  esac
  if rm -rf -- "$target" 2>/dev/null; then
    say "  ${GREEN}removed${OFF} $target"
    REMOVED=$((REMOVED + 1))
  elif sudo -n rm -rf -- "$target" 2>/dev/null; then
    say "  ${GREEN}removed${OFF} $target ${DIM}(with sudo)${OFF}"
    REMOVED=$((REMOVED + 1))
  else
    say "  ${RED}could not remove${OFF} $target ${DIM}(try: sudo rm -rf $target)${OFF}"
    PROBLEMS=1
  fi
}

step "Looking for OmniHilbras on this machine"

NPM_PRESENT=0
if command -v npm >/dev/null 2>&1; then NPM_PRESENT=1; fi

GLOBAL_PACKAGES=()
if [ "$NPM_PRESENT" = 1 ]; then
  # `npm ls -g --json` exits non-zero on a broken tree and still prints the tree, so its output is read
  # either way — a broken global tree is exactly when leftovers are most likely.
  GLOBAL_JSON="$(npm ls -g --json --depth=0 2>/dev/null || true)"
  for name in "${PACKAGE_NAMES[@]}"; do
    if printf '%s' "$GLOBAL_JSON" | grep -q "\"$name\""; then
      # `grep -o` rather than `sed`, because the package name contains a slash and interpolating it into
      # an `s///` expression makes sed read the name as a delimiter.
      # npm prints this tree **pretty-printed**, so the name and its version are not on one line:
      #   "@hilbras/omnihilbras": {
      #     "version": "2.9.18"
      # Reading a fixed number of lines after the name is what survives that, where a single-line pattern
      # silently reported an empty version.
      version="$(printf '%s' "$GLOBAL_JSON" | grep -A 3 "\"$name\":" | grep -m1 '"version"' | sed 's/.*: *"//; s/".*//')"
      GLOBAL_PACKAGES+=("$name|$version")
    fi
  done
fi

PATHS_FOUND=()
IFS=':' read -r -a PATH_PARTS <<< "${PATH:-}"
for dir in "${PATH_PARTS[@]}"; do
  [ -n "$dir" ] || continue
  for name in omnihilbras; do
    if present "$dir/$name"; then PATHS_FOUND+=("$dir/$name"); fi
  done
done
# npm's own global bin directory, which is where the binary lands even when it is not on PATH yet.
if [ "$NPM_PRESENT" = 1 ]; then
  NPM_BIN="$(npm prefix -g 2>/dev/null)/bin"
  if present "$NPM_BIN/omnihilbras"; then
    already=0
    for found in "${PATHS_FOUND[@]:-}"; do [ "$found" = "$NPM_BIN/omnihilbras" ] && already=1; done
    [ "$already" = 1 ] || PATHS_FOUND+=("$NPM_BIN/omnihilbras")
  fi
fi

APP_FOUND=()
for dir in "${APP_DIRS[@]}"; do present "$dir" && APP_FOUND+=("$dir"); done

AUTOSTART_FOUND=()
for file in "${AUTOSTART_FILES[@]}"; do present "$file" && AUTOSTART_FOUND+=("$file"); done

DATA_FOUND=()
for dir in "${DATA_DIRS[@]}"; do present "$dir" && DATA_FOUND+=("$dir"); done

say ""
if [ "$NPM_PRESENT" = 1 ]; then say "  npm:            $(npm --version 2>/dev/null || echo unknown)"; else say "  npm:            ${YELLOW}not found${OFF} — package removal will be skipped"; fi
if [ "${#GLOBAL_PACKAGES[@]}" -gt 0 ]; then
  for entry in "${GLOBAL_PACKAGES[@]}"; do say "  npm global:     ${entry%%|*} ${entry##*|}"; done
else
  say "  npm global:     none"
fi
if [ "${#PATHS_FOUND[@]}" -gt 0 ]; then
  for found in "${PATHS_FOUND[@]}"; do say "  on PATH:        $found"; done
else
  say "  on PATH:        none"
fi
if [ "${#APP_FOUND[@]}" -gt 0 ]; then
  for found in "${APP_FOUND[@]}"; do say "  application:    $found"; done
else
  say "  application:    none"
fi
if [ "${#AUTOSTART_FOUND[@]}" -gt 0 ]; then
  for found in "${AUTOSTART_FOUND[@]}"; do say "  autostart:      $found"; done
fi
if [ "${#DATA_FOUND[@]}" -gt 0 ]; then
  for found in "${DATA_FOUND[@]}"; do say "  your data:      $found"; done
fi

# The `.deb` does not only create a symlink: electron-builder's generated after-install registers
# `/usr/bin/omnihilbras` as an **update-alternative**, which is why the link goes through
# `/etc/alternatives/omnihilbras`. It is found and reported with everything else, because deleting the
# symlink without deregistering leaves the registration to put it straight back on the next
# `update-alternatives --auto` — an uninstall that undoes itself.
ALTERNATIVES_FOUND=()
if command -v update-alternatives >/dev/null 2>&1; then
  while read -r alt_path; do
    [ -n "$alt_path" ] && ALTERNATIVES_FOUND+=("$alt_path")
  done <<EOF
$(update-alternatives --query omnihilbras 2>/dev/null | sed -n 's/^Alternative: //p')
EOF
fi
for alt_path in "${ALTERNATIVES_FOUND[@]:-}"; do
  [ -n "$alt_path" ] && say "  alternative:    omnihilbras → $alt_path"
done

if [ "${#GLOBAL_PACKAGES[@]}" -eq 0 ] && [ "${#PATHS_FOUND[@]}" -eq 0 ] && [ "${#APP_FOUND[@]}" -eq 0 ] && [ "${#AUTOSTART_FOUND[@]}" -eq 0 ] && [ "${#DATA_FOUND[@]}" -eq 0 ] && [ "${#ALTERNATIVES_FOUND[@]}" -eq 0 ]; then
  say ""
  say "${GREEN}Nothing to remove.${OFF}"
  exit 0
fi

# Running servers hold the ports and, on Windows, the files. Reported rather than killed: this script's job
# is to remove an installation, not to decide that a process it did not start should die.
step "Checking for running processes"
# The two programs that are this project: the launcher and the gateway. Matching the bare word
# "omnihilbras" also matched every process started from a directory with OmniHilbras in its path —
# browsers and shells included — which is a list nobody can act on.
RUNNING="$(pgrep -af 'bin/omnihilbras\.js|dist/src/main\.js' 2>/dev/null | grep -v 'uninstall\|--test' | head -10 || true)"
if [ -n "$RUNNING" ]; then
  say "$RUNNING"
  note "  Stop these first (Ctrl-C in the terminal that started them, or \`pkill -f omnihilbras\`)."
else
  say "  none"
fi

if [ "$DRY_RUN" = 1 ]; then
  step "Dry run — nothing was removed"
  note "  Re-run without --dry-run to remove the items listed above."
  exit 0
fi

if [ "$ASSUME_YES" != 1 ]; then
  if [ ! -t 0 ]; then
    step "No terminal to confirm on"
    note "  Nothing was removed. Re-run with --yes, or --dry-run to see the list."
    exit 0
  fi
  say ""
  printf '%sRemove the npm packages, PATH binaries, application directories and autostart entries?%s [y/N] ' "$BOLD" "$OFF"
  read -r answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *) say "${YELLOW}Cancelled. Nothing was removed.${OFF}"; exit 130 ;;
  esac
fi

step "Removing"

if [ "$NPM_PRESENT" = 1 ]; then
  for entry in "${GLOBAL_PACKAGES[@]:-}"; do
    [ -n "$entry" ] || continue
    name="${entry%%|*}"
    if npm rm -g "$name" >/dev/null 2>&1; then
      say "  ${GREEN}removed${OFF} npm package $name"
      REMOVED=$((REMOVED + 1))
    else
      say "  ${RED}could not remove${OFF} npm package $name ${DIM}(try: sudo npm rm -g $name)${OFF}"
      PROBLEMS=1
    fi
  done
fi

for found in "${PATHS_FOUND[@]:-}"; do
  [ -n "$found" ] || continue
  # A leftover binary is what makes an uninstall look like it did nothing, so it goes even though npm
  # never knew about it.
  remove_path "$found"
done

# Deregistered before the symlink is removed: `update-alternatives --remove` owns that file, and deleting it
# first leaves the registration behind.
for alt_path in "${ALTERNATIVES_FOUND[@]:-}"; do
  [ -n "$alt_path" ] || continue
  if update-alternatives --remove omnihilbras "$alt_path" >/dev/null 2>&1; then
    say "  ${GREEN}deregistered${OFF} alternative omnihilbras → $alt_path"
    REMOVED=$((REMOVED + 1))
  else
    say "  ${RED}could not deregister${OFF} alternative omnihilbras → $alt_path ${DIM}(try: sudo update-alternatives --remove omnihilbras $alt_path)${OFF}"
    PROBLEMS=1
  fi
done

# macOS has no installer hook, so its shortcut is a script the person ran once; removing it is the same
# script in reverse, run here so an uninstall does not leave a link in /usr/local/bin.
MACOS_SHIM="$(dirname "$0")/../installer/macos/shortcut.sh"
if [ -x "$MACOS_SHIM" ]; then
  bash "$MACOS_SHIM" --uninstall 2>/dev/null | sed 's/^/  /' || true
fi

for dir in "${APP_FOUND[@]:-}"; do [ -n "$dir" ] && remove_path "$dir"; done
for file in "${AUTOSTART_FOUND[@]:-}"; do [ -n "$file" ] && remove_path "$file"; done

if [ "$PURGE_DATA" = 1 ]; then
  step "Removing your data (--purge-data)"
  say "${RED}This includes the vault: every saved provider credential and every gateway key.${OFF}"
  note "  It cannot be recovered. Provider sessions and API keys will have to be re-added from scratch."
  for dir in "${DATA_FOUND[@]:-}"; do [ -n "$dir" ] && remove_path "$dir"; done
else
  step "Keeping your data"
  for dir in "${DATA_FOUND[@]:-}"; do [ -n "$dir" ] && say "  kept $dir"; done
  note "  The vault holds your provider credentials and gateway keys. Pass --purge-data to remove it too."
fi

step "Done"
say "  removed: $REMOVED item(s)"
if [ "$PROBLEMS" = 1 ]; then
  say "  ${YELLOW}some items could not be removed — see the lines above${OFF}"
  exit 1
fi
exit 0
