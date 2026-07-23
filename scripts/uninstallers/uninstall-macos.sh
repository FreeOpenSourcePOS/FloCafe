#!/bin/bash
# Flo Cafe — standalone macOS uninstaller
#
# Removes the Flo Cafe app and its support files (preferences, caches, logs,
# auto-update state). Your business data (SQLite database, backups, Master
# PIN) is left alone unless you pass --purge-data.
#
# Download and run directly, no need to clone the repo:
#   curl -fsSL https://github.com/FreeOpenSourcePOS/FloCafe/releases/latest/download/uninstall-macos.sh -o uninstall-macos.sh
#   chmod +x uninstall-macos.sh
#   ./uninstall-macos.sh
#
# Usage:
#   ./uninstall-macos.sh              Remove the app + support files, keep your data
#   ./uninstall-macos.sh --purge-data Also delete your database, backups, and Master PIN (irreversible)
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
  if [ -e "$target" ] || [ -L "$target" ]; then
    run rm -rf "$target"
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
  log "quit $APP_NAME"
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

if [ "$PURGE_DATA" -eq 1 ]; then
  step "⚠️  Removing your business data (database, backups, Master PIN)…"
  log "this is irreversible — there is no undo"
  remove_path "$HOME/Library/Application Support/$APP_NAME"
else
  step "Keeping your business data"
  log "database, backups, and Master PIN remain at:"
  log "  ~/Library/Application Support/$APP_NAME"
  log "re-run with --purge-data to also delete this (irreversible)"
fi

step "Done."
if [ "$DRY_RUN" -eq 1 ]; then log "(dry run — nothing was actually deleted)"; fi
