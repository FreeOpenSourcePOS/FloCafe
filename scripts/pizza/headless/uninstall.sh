#!/usr/bin/env bash
# Stops and removes the POS user service, the backup timer and the kit's settings file. Works when
# the kit is only partly installed or not installed. The data folder and its backups stay.
set -euo pipefail

config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
unit_dir="$config_home/systemd/user"
units=(pizza-pos.service pizza-pos-backup.timer)

# Either call fails for a unit that is not installed or not loaded; the check below decides.
systemctl --user disable "${units[@]}" 2> /dev/null || true
systemctl --user stop "${units[@]}" 2> /dev/null || true
rm -f "$unit_dir/pizza-pos.service" "$unit_dir/pizza-pos-backup.service" "$unit_dir/pizza-pos-backup.timer"
rm -f "$config_home/pizza-pos/headless.env"
rmdir "$config_home/pizza-pos" 2> /dev/null || true
systemctl --user daemon-reload
systemctl --user reset-failed pizza-pos.service pizza-pos-backup.service 2> /dev/null || true

for unit in "${units[@]}"; do
  if systemctl --user is-active --quiet "$unit"; then
    echo "$unit is still running. See: systemctl --user status $unit" >&2
    exit 1
  fi
done
echo "Removed the pizza-pos service, backup timer and settings. Data folders were not touched."
