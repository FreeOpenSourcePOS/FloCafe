#!/usr/bin/env bash
# Builds the POS and installs it as a systemd user service with a daily backup timer.
# Usage: PORT=3001 KDS_PORT=3002 SERVER_APP_PORT=3003 FLO_DEV_USER_DATA=/abs/data BACKUP_KEEP=14 \
#          scripts/pizza/headless/install.sh
set -euo pipefail

kit="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$kit/../../.." && pwd)"
config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
env_file="$config_home/pizza-pos/headless.env"
unit_dir="$config_home/systemd/user"

node "$kit/write-units.cjs" "$env_file" "$unit_dir"
mkdir -p "$FLO_DEV_USER_DATA"
(cd "$repo" && npm run build && npm run build:frontend)

systemctl --user daemon-reload
systemctl --user enable pizza-pos.service pizza-pos-backup.timer
# Restart, not start: a running service from an earlier install keeps its old settings and code.
systemctl --user restart pizza-pos.service pizza-pos-backup.timer

set -a
# shellcheck disable=SC1090
. "$env_file"
set +a
for _ in $(seq 30); do
  if node "$kit/health.cjs" > /dev/null 2>&1; then
    node "$kit/health.cjs"
    echo "Installed. Data: $FLO_DEV_USER_DATA. Settings: $env_file"
    exit 0
  fi
  sleep 2
done
node "$kit/health.cjs" || true
echo "The POS did not become healthy within 60 seconds. See: journalctl --user -u pizza-pos.service" >&2
exit 1
