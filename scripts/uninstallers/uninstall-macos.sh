#!/bin/bash
# Flo Cafe — standalone macOS uninstaller
#
# Removes the Flo Cafe app and its support files (preferences, caches, logs,
# auto-update state). Your business data (SQLite database, backups, Master
# PIN) is only deleted if you say so: interactively, you'll be asked
# Delete or Keep; non-interactively, pass --purge-data to delete it or
# leave it out to keep it.
#
# Download and run directly, no need to clone the repo:
#   curl -fsSL https://github.com/FreeOpenSourcePOS/FloCafe/releases/latest/download/uninstall-macos.sh -o uninstall-macos.sh
#   chmod +x uninstall-macos.sh
#   ./uninstall-macos.sh
#
# Usage:
#   ./uninstall-macos.sh              Remove the app + support files; asks whether to also delete your data
#   ./uninstall-macos.sh --purge-data Also delete your database, backups, and Master PIN without asking (irreversible)
#   ./uninstall-macos.sh --dry-run    Show what would be removed without touching anything

set -euo pipefail

APP_NAME="Flo Cafe"
BUNDLE_ID="com.flo.desktop"
PURGE_DATA=0
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --purge-data) PURGE_DATA=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,16p' "$0" | sed 's/^#//; s/^ //'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (use --help)" >&2
      exit 1
      ;;
  esac
done

log()  { printf '  %s\n' "$1"; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }
run()  {
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] $*"
  else
    "$@"
  fi
}
remove_path() {
  local target="$1"
  if [ ! -e "$target" ] && [ ! -L "$target" ]; then
    return
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] would remove $target"
    return
  fi
  # `set -e` would otherwise exit here and make the retry loop unreachable.
  rm -rf "$target" || true
  # rm -f masks failures (e.g. a file still open by a not-fully-quit Flo Cafe
  # process) -- verify instead of just trusting it and reporting success.
  for _ in 1 2 3 4 5 6; do
    if [ ! -e "$target" ] && [ ! -L "$target" ]; then break; fi
    sleep 0.5
    rm -rf "$target" || true
  done
  if [ -e "$target" ] || [ -L "$target" ]; then
    echo -e "  \033[33mcould NOT fully remove $target -- some files are still in use.\033[0m"
    echo -e "  \033[33mmake sure Flo Cafe is completely quit (check Activity Monitor), then re-run this script.\033[0m"
  else
    log "removed $target"
  fi
}

step "Flo Cafe uninstaller (macOS)"
if [ "$DRY_RUN" -eq 1 ]; then log "(dry run — nothing will actually be deleted)"; fi

step "Quitting Flo Cafe if it's running…"
if pgrep -x "$APP_NAME" >/dev/null 2>&1; then
  run osascript -e "tell application \"$APP_NAME\" to quit" || true
  sleep 1
  run pkill -x "$APP_NAME" 2>/dev/null || true
  # Wait for it to actually exit so the SQLite db/log files below aren't
  # still locked when we try to delete them a moment later.
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
    pgrep -x "$APP_NAME" >/dev/null 2>&1 || break
    sleep 0.5
  done
  if pgrep -x "$APP_NAME" >/dev/null 2>&1; then
    log "could not confirm that $APP_NAME quit; locked files may remain"
  else
    log "quit $APP_NAME"
  fi
else
  log "not running"
fi

step "Removing the app bundle…"
FOUND_APP=0
for app_dir in "/Applications/$APP_NAME.app" "$HOME/Applications/$APP_NAME.app"; do
  if [ -d "$app_dir" ]; then
    FOUND_APP=1
    remove_path "$app_dir"
  fi
done
if [ "$FOUND_APP" -eq 0 ]; then log "no app bundle found in /Applications or ~/Applications"; fi

step "Removing support files (preferences, caches, logs, auto-update state)…"
remove_path "$HOME/Library/Preferences/$BUNDLE_ID.plist"
remove_path "$HOME/Library/Caches/$BUNDLE_ID"
remove_path "$HOME/Library/Caches/$BUNDLE_ID.ShipIt"
remove_path "$HOME/Library/Logs/$APP_NAME"
remove_path "$HOME/Library/Saved Application State/$BUNDLE_ID.savedState"
remove_path "$HOME/Library/HTTPStorages/$BUNDLE_ID"
remove_path "$HOME/Library/WebKit/$BUNDLE_ID"

# Electron's default userData dir comes from package.json's top-level "name"
# ("flo-desktop"), not the electron-builder "productName" ("Flo Cafe") used
# for the .app bundle -- so the real data lives under "flo-desktop", not
# under "$APP_NAME". Sweep both so stray data from either naming never
# survives an uninstall.
DATA_PATH="$HOME/Library/Application Support/flo-desktop"
LEGACY_DATA_PATH="$HOME/Library/Application Support/$APP_NAME"
step "Your business data"
log "database, backups, and Master PIN live at:"
log "  $DATA_PATH"

if [ "$PURGE_DATA" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
  echo
  echo -e "\033[1m⚠️  Delete this data too? This is IRREVERSIBLE — there is no undo.\033[0m"
  answer=""
  if ! { read -r -p "Delete or Keep? [d/K] " answer < /dev/tty; } 2>/dev/null; then
    answer=""
    log "no terminal available to prompt — keeping your data (pass --purge-data to delete non-interactively)"
  fi
  case "$answer" in
    [Dd]*) PURGE_DATA=1 ;;
    *) PURGE_DATA=0 ;;
  esac
fi

if [ "$PURGE_DATA" -eq 1 ]; then
  step "Removing your business data…"
  remove_path "$DATA_PATH"
  remove_path "$LEGACY_DATA_PATH"
else
  log "keeping your data"
fi

step "Done."
if [ "$DRY_RUN" -eq 1 ]; then log "(dry run — nothing was actually deleted)"; fi
