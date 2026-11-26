# Running the POS headless on Linux

This page is for the person who sets up the shop's small Linux PC: no monitor, no Electron, tablets on the LAN open the POS in a browser. The kit in [`scripts/pizza/headless/`](../scripts/pizza/headless/) runs the server as a systemd user service, backs it up every day, restores a backup, and checks that every service is on its port. Nothing needs `sudo`.

| Script | What it does |
| :--- | :--- |
| `install.sh` | Writes the settings file and the units, builds the POS, enables the service and the daily backup timer, waits until healthy |
| `uninstall.sh` | Stops and removes the service, the timer and the settings file; leaves the data folder alone |
| `health.cjs` | Fails unless the API, KDS and Server App each answer on their configured port, and the newest backup is under 26 hours old |
| `backup.cjs` | Takes an online backup of the live database and keeps the newest `BACKUP_KEEP` copies |
| `restore.cjs` | Restores a chosen backup with the service stopped, after saving a copy of the current database |
| `write-units.cjs` | Writes the settings file and the three unit files; `install.sh` calls it |

## Install

You need Node 22 or later, and a clone of this repository with its dependencies installed:

```sh
npm ci
npm --prefix frontend ci
```

Then install, choosing the ports, the data folder and how many daily backups to keep. The data folder must be an absolute path made of letters, digits, `.`, `_`, `-` and `/`.

```sh
PORT=3001 KDS_PORT=3002 SERVER_APP_PORT=3003 \
FLO_DEV_USER_DATA=$HOME/.local/share/pizza-pos BACKUP_KEEP=14 \
  scripts/pizza/headless/install.sh
```

The script writes these files and enables the service and the timer:

| File | Holds |
| :--- | :--- |
| `~/.config/pizza-pos/headless.env` | The five settings above. Every unit and script reads them from here. |
| `~/.config/systemd/user/pizza-pos.service` | Runs `dev-server.js` with the Node that ran the install, by absolute path; restarts it on failure |
| `~/.config/systemd/user/pizza-pos-backup.service` | Runs `backup.cjs` once |
| `~/.config/systemd/user/pizza-pos-backup.timer` | Runs the backup service daily, and on the next boot if the PC was off at midnight |

To change a setting, or after pulling new code, run `install.sh` again with the values you want. It rewrites the files and restarts the service, so the running POS picks up the new settings and code.

The Node path is fixed in the units at install time. After upgrading Node, run `npm rebuild better-sqlite3` (or `npm ci`) and then `install.sh` again. After moving the repository, run `install.sh` again from its new place.

The first time the POS runs, open `http://<pc address>:<PORT>` from a tablet and finish setup there. A new install starts in offline mode (decision D13 in [decisions.md](decisions.md)).

To load the shop's menu, sign in as the owner or a manager, open **Pizza menu** in the sidebar, choose the shop's menu file (`.json`) and confirm. Load the file again whenever it changes: the file is the master copy, so names, prices and what is on sale follow it, and anything it no longer has is switched off.

### Start at boot

A user service runs only while that user has a session, unless lingering is on. Turn it on once, as the user that owns the service:

```sh
loginctl enable-linger
```

Without it, the POS starts only when that user logs in.

## Check health

```sh
set -a; . ~/.config/pizza-pos/headless.env; set +a
node scripts/pizza/headless/health.cjs
```

It prints one line per check and exits non-zero if any service is not answering its own health check on its configured port, or if the newest backup is more than 26 hours old:

```text
ok   PORT=3001 (Flo Local API)
ok   KDS_PORT=3002 (Flo KDS Server)
FAIL SERVER_APP_PORT=3003 (Flo Server App): ECONNREFUSED
ok   backups: newest pizza-pos-2026-11-25T07-00-03-120Z.db is 3.2 h old (limit 26 h)
```

Before the first daily backup there is no backup folder yet, and the backup line says `skip backups: no backup folder yet`. Once the folder exists, a missing or old backup fails the check.

Whatever watches the PC should run `health.cjs` on a schedule and alert on a non-zero exit. It is the one check that covers the services, their ports and the backups.

When a port is taken at start-up the server does not fail; it binds the next free port and logs `Port 3003 in use`. Tablets pointed at the configured port then cannot reach it, which is what this check catches. Find what holds the port with `ss -ltnp 'sport = :3003'`, free it, and restart the service.

The service log is in the user journal:

```sh
journalctl --user -u pizza-pos.service -f
```

## Backups

The timer takes one backup a day. To take one now, and to see when the next one runs:

```sh
systemctl --user start pizza-pos-backup.service
systemctl --user list-timers pizza-pos-backup.timer
```

Backups are written to `headless-backups/` inside the data folder, named `pizza-pos-<UTC time>.db`. Each one is taken with SQLite's online backup while the POS keeps running, stamped the way the app stamps its own backups, and checked with the app's own database health check before it is kept. A backup that fails that check is deleted and the run fails, so `systemctl --user status pizza-pos-backup.service` shows it. The newest `BACKUP_KEEP` backups are kept and older ones are deleted.

The backups sit on the same disk as the database. Copy that folder somewhere else if the PC itself may be lost.

## Restore

Restore runs with the POS stopped. It refuses while `systemctl --user is-active` reports `pizza-pos.service` or `pizza-pos-backup.service` as anything but inactive or failed, and while anything listens on the three configured ports. Without `systemctl` it says so and relies on the port check.

```sh
set -a; . ~/.config/pizza-pos/headless.env; set +a
ls "$FLO_DEV_USER_DATA/headless-backups"
systemctl --user stop pizza-pos.service
node scripts/pizza/headless/restore.cjs "$FLO_DEV_USER_DATA/headless-backups/pizza-pos-<time>.db"
systemctl --user start pizza-pos.service
node scripts/pizza/headless/health.cjs
```

Before it changes anything, `restore.cjs` saves the current database as `headless-backups/pre-restore-<UTC time>.db` and checks that copy with the app's database health check; if the copy fails, it stops and changes nothing. Retention never deletes these copies. It then runs the app's own `restoreBackup()`, the same sequence as the app's restore-from-file route: it validates the backup, replaces the database, signs everyone out and clears device pairings. Staff log in again on every tablet, and KDS and customer displays are paired again.

To undo a restore, restore the `pre-restore-` copy the same way. The app's restore also keeps its own copy of the replaced database in `backups/` inside the data folder, named `flo-backup-<time>-pre-restore-v<schema>.db`.

### The live database is missing or will not open

The restore needs a working current database to copy and open. When `flo.db` is gone or damaged, or the safety copy fails its check, set the broken files aside and let the POS create an empty database first:

```sh
set -a; . ~/.config/pizza-pos/headless.env; set +a
systemctl --user stop pizza-pos.service
broken="$FLO_DEV_USER_DATA/broken-$(date +%Y%m%d-%H%M%S)"
mkdir "$broken"
mv "$FLO_DEV_USER_DATA"/flo.db* "$FLO_DEV_USER_DATA/.flo-db-initialized" "$broken"/
systemctl --user start pizza-pos.service
node scripts/pizza/headless/health.cjs   # wait until the three service lines say ok
systemctl --user stop pizza-pos.service
node scripts/pizza/headless/restore.cjs "$FLO_DEV_USER_DATA/headless-backups/pizza-pos-<time>.db"
systemctl --user start pizza-pos.service
```

Move `.flo-db-initialized` as well: while it is there, the server refuses to start without its database rather than create a new one. Keep the `broken-` folder until the restored store has been checked.

## Printing

Network ESC/POS printers work headless: a kitchen ticket sent through the headless server reaches a printer at an IP address and port (`tests/pizza-headless-print.test.ts` proves it against a loopback printer). Printing needs regional settings, which setup fills in. What needs an Electron window does not work: raster printing and PDF.

## What headless mode does not do

These run only in the desktop app (decision D15): LAN HTTPS, mDNS discovery, raster printing and PDF, cloud sync, telemetry and Google Drive. Tablets use plain `http://` on the LAN.

## Uninstall

```sh
scripts/pizza/headless/uninstall.sh
```

It stops and disables the service and the timer, deletes the three unit files and the settings file, reloads systemd, and fails if the service is still running. It also works when the kit is only partly installed, or not installed. The data folder and its backups stay; delete them yourself when you no longer need them. If you turned lingering on and no longer need it, `loginctl disable-linger`.

## What has been checked, and what has not

| Step | Checked how |
| :--- | :--- |
| Unit files, health, backup, restore, recovery steps | 21 test cases against a real headless server, with a stand-in for `systemctl` |
| Install as a user service, health on fixed ports | Run for real on Fedora 45 (systemd 262) |
| Install again with a changed port | Run for real: the server restarted on the new port |
| Backup and restore through the real service manager | Run for real with the first version of the kit only |
| Uninstall, and uninstall a second time | **Not run end to end** |
| Start at boot with lingering, the timer firing at midnight, a tablet over the LAN, a real printer | Not checked |

**Open risk.** Both rehearsals were on a developer's live desktop session, and both times that session's service manager stopped starting new jobs part-way through (jobs sat in "waiting"; `systemctl --user daemon-reexec` cleared it). That manager logged a resource-busy warning on every reload and had left a restart queued for nine minutes, so it may have been unhealthy already, but the kit has not been shown to be harmless on a healthy one. Rehearse it on the shop's machine, or on a clean Linux install, before relying on it, and check `systemctl --user list-jobs` is empty afterwards.

