# Hosting the Yoyo Collection on a NAS or Linux server

This app is a Docker container that needs **one persistent local disk**, which
is exactly what a NAS is. The prebuilt image runs unmodified — no cloning, no
building, no reverse proxy, no certificates.

Covers OpenMediaVault, Unraid, Synology, TrueNAS SCALE, QNAP, and any generic
Linux box (Proxmox, Raspberry Pi, a VPS). The setup is the same everywhere;
[Platform notes](#platform-notes) below carries the per-system paths, GUI steps,
and quirks.

This guide assumes **LAN-only** access. See
[REMOTE-ACCESS.md](REMOTE-ACCESS.md) when you need it from elsewhere.

---

# Part 1 — the parts that are the same everywhere

## 1. The one rule: a real local filesystem ⚠️

**This matters more than the rest of the guide combined.**

The database is SQLite, and SQLite's locking assumes a real local filesystem.
Its own docs are blunt: *"WAL does not work over a network filesystem"* and
*"your best defense is to not use SQLite for files on a network filesystem."*

So the app's data directory must **not** live on:

- a **union / FUSE layer** — mergerfs on OMV, `/mnt/user` (shfs) on Unraid
- a **network share** — NFS, SMB/CIFS, or any remote mount

Use plain **ext4, XFS, btrfs, or ZFS on a local disk** — ideally an SSD.

The failure mode is **silent**, which is what makes it dangerous. On an
unsupported filesystem `PRAGMA journal_mode = WAL` is quietly ignored, nothing
errors, and the checkpoint that makes the backup zip trustworthy becomes a
no-op. You find out when the database is already damaged.

Photos would be fine on a big pool, but keep them with the database anyway.
They're one logical unit, and the backup endpoint archives them as a pair.

### On an SBC (Raspberry Pi, ODROID, etc.) — the microSD rule ⚠️

Single-board computers add a second trap: **the boot media**. Boards like the
ODROID HC-4 boot from microSD and have no eMMC, and a microSD card is the worst
possible home for a SQLite database. WAL produces a steady stream of small,
frequent, fsync'd writes — close to the worst case for card endurance, with no
meaningful wear-leveling to absorb it. You get months, not years, and the
failure takes the collection with it.

Two things must live on real storage (SATA or USB3 SSD), not the card:

- **the app's data directory**, and
- **Docker's storage root** (`/var/lib/docker`), which sits *on the card* by
  default. Image layers and container writable layers churn constantly.

On OMV, also install the **`openmediavault-flashmemory`** plugin — it uses
folder2ram to keep logs off the boot device and exists for exactly this case.

If the board has spinning disks with APM/spin-down enabled, prefer an SSD for
the data. Otherwise the database's periodic writes either keep the disk awake or
add spin-up latency to page loads, and the cycling wears the drive.

## 2. The compose file

The same everywhere. Substitute your platform's path from
[Platform notes](#platform-notes) for `/PATH/TO`:

```yaml
services:
  yoyo:
    image: ghcr.io/stammig/yoyo-collection:latest
    container_name: yoyo-collection
    ports:
      - "3000:3000"
    volumes:
      - /PATH/TO/appdata/yoyo-collection:/data
    environment:
      DB_PATH: /data/yoyos.db
      UPLOAD_DIR: /data/uploads
    restart: unless-stopped
```

Give the app **its own subfolder** rather than mounting a shared `appdata` root
— that keeps its data separate from every other container's.

Use a **bind mount, not a named volume**. A named volume lives inside Docker's
storage root where your NAS's backup tooling can't see it, which breaks step 6.

**Port 3000 is popular** (Grafana, Homepage, and others default to it). If it's
taken, change only the left-hand side: `"3456:3000"`.

The image is multi-arch **amd64 + arm64**, so it runs on an x86 NAS, Apple
Silicon, a Pi 4/5, or an ODROID alike. It does *not* cover 32-bit ARM — see the
Synology and QNAP notes.

## 3. What LAN-only lets you turn off

Most of this app's security surface exists to protect a *public* instance. On a
trusted LAN it earns nothing:

- **Leave `ADMIN_PASSWORD` unset.** The public-read / owner-edit split protects
  a public showcase. You're the only visitor — run it fully open.
- **Leave `RATE_LIMIT_MAX` unset.** It's there to stop bots.
- **Plain HTTP is fine.** The login cookie already falls back to `SameSite=Lax`
  without `Secure` when it doesn't see HTTPS.

All of this reverses the moment you expose it — see
[REMOTE-ACCESS.md](REMOTE-ACCESS.md).

## 4. Verify your storage before you start

Worth 30 seconds, because both failure modes below look like success. From a
shell on the host:

```bash
uname -m                                       # architecture
findmnt -no SOURCE,FSTYPE /var/lib/docker      # where Docker actually writes
lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINT,ROTA      # what's mounted where
free -h                                        # available RAM
```

| Command | Good | Bad |
|---|---|---|
| `uname -m` | `x86_64` or `aarch64` | `armv7l` — 32-bit, the image won't run |
| `findmnt … /var/lib/docker` | your SSD, `ext4`/`btrfs`/`zfs` | the boot device, or **no output** |
| `lsblk` | data path on a real disk, `ROTA=0` for SSD | the path missing entirely |
| `free -h` | 4 GB+ | under 2 GB — see the restore note in the gotchas |

**No output from `findmnt` means Docker is still on the root filesystem** — on
an SBC, that's the microSD card. And if your data path doesn't appear under
`lsblk`'s mountpoints, a typo'd path has silently created an empty folder on the
OS drive, which is the same problem in disguise.

Check the app's data path specifically:

```bash
findmnt -no SOURCE,FSTYPE -T /PATH/TO/appdata/yoyo-collection
```

That should name a real block device and a real filesystem — not `fuse`,
`overlay`, `nfs`, or `cifs`.

## 5. Move your data over

Use the app's own tooling — it moves the database *and* photos as one file:

1. On the **old** instance: **Settings ⚙ → Backup** → downloads a
   `yoyo-backup-YYYY-MM-DD.zip`.
2. On the **new** instance: **Settings ⚙ → Restore** → upload that zip.

Restore **replaces** the entire collection, so do it before you add anything
you'd miss.

Starting fresh? **⤴ Import CSV** takes a spreadsheet — column order and case
don't matter, and `$85.00` / `64.60 g` parse correctly. Photos aren't part of a
CSV import.

## 6. Backups

Hosting was never what was likely to lose this collection — a dead disk or a
mis-click is. Two layers:

**Layer 1 — your platform's native tool.** Each one is listed in
[Platform notes](#platform-notes). This is why step 2 used a bind mount: a named
volume is invisible to all of them.

**Layer 2 — the app's own zip.** **Settings ⚙ → Backup** bundles the database
and every photo into one file. *This* is the one safe to drop in
Dropbox/Drive/iCloud, and the one that moves between machines.

> ⚠️ Never let a file-sync service touch the **live** `yoyos.db`. It copies
> mid-write and doesn't understand SQLite's `-wal` / `-shm` sidecars, which can
> corrupt the collection. The zip has no such problem.

## 7. Updating

Pull the new image and recreate the container — the GUI path is in each platform
section, or from a shell:

```bash
docker compose pull && docker compose up -d
```

Your data lives in the bind mount, not the image, so it's untouched.
**Settings ⚙ → Version & updates** in the app tells you when a release is out.

## 8. Reaching it from outside the LAN

Install **Tailscale** and you're there — no port forwarding, nothing exposed,
and no changes to the app's configuration because the network stays the
boundary. See [REMOTE-ACCESS.md](REMOTE-ACCESS.md) for that and the other
options, including the checklist for genuinely publishing it.

---

# Platform notes

Only the differences. Everything in Part 1 still applies.

## OpenMediaVault

Requires OMV 7 with **omv-extras** and the **openmediavault-compose** plugin
(System → Plugins).

- **Data path:** `/srv/dev-disk-by-uuid-XXXX/appdata/yoyo-collection`
- **Create the share:** Storage → Shared Folders → Create, name `appdata`, on
  your ext4 SSD. Then `mkdir -p .../appdata/yoyo-collection`.
- **Point the plugin at storage:** Services → Compose → Settings → set
  *Docker storage* to `/srv/dev-disk-by-uuid-XXXX/docker` and *Compose files* to
  `.../appdata/compose`. Keeping Docker off the OS drive is the wiki's standing
  recommendation, and mandatory on an SBC.
- **Add the stack:** Services → Compose → Files → Create, paste, then **Up**.
- **Update:** select the file → **Pull**, then **Up**.
- **Backups:** Services → Rsync → Jobs, source
  `.../appdata/yoyo-collection/`, nightly.

⚠️ **Avoid mergerfs.** The OMV wiki agrees: *"the file system where the docker
folder is should preferably be EXT4"* and *"do not place the docker folder in a
merges pool."*

## Unraid

Requires the **Compose Manager** plugin from Community Applications.

- **Data path:** `/mnt/cache/appdata/yoyo-collection` — substitute your pool's
  actual name if it isn't `cache`.
- **Add the stack:** Docker → Compose → Add New Stack → ⚙ → Edit Stack →
  Compose File. Optionally add these labels for an icon and a working WebUI
  link on the Docker tab:
  ```yaml
    labels:
      net.unraid.docker.icon: "https://raw.githubusercontent.com/stammig/yoyo-collection/main/public/favicon.png"
      net.unraid.docker.webui: "http://[IP]:[PORT:3000]"
  ```
- **Update:** Docker → Compose → ⚙ → **Update Stack**.
- **Backups:** the **CA Appdata Backup** plugin. It stops the container,
  archives, and restarts — a clean snapshot with no torn writes.

⚠️ **Never use `/mnt/user/`.** It's **shfs**, a FUSE union layer, and it's the
source of the SQLite corruption reports that recur on the Unraid forums version
after version. Use the pool path directly.

⚠️ **Pin the share to the pool.** Shares → appdata → *Primary storage:* your
pool, *Secondary storage:* none (older Unraid: *Use cache: Only*). Otherwise the
Mover can relocate the database onto the array mid-write.

## Synology

Requires **DSM 7.2+** with **Container Manager** (Package Center).

- **Data path:** `/volume1/docker/yoyo-collection/data` — compose paths on
  Synology **must include the volume number**.
- **Create the project:** Container Manager → Project → Create, name it, browse
  to `/volume1/docker/yoyo-collection`, choose *Create docker-compose.yml*, and
  paste. The `/data` subfolder keeps app data out of the project folder
  Container Manager writes into.
- **Update:** Project → yoyo-collection → Action → **Build**.
- **Backups:** **Hyper Backup**. On btrfs volumes add **Snapshot Replication**
  too — near-instant, and independent of Hyper Backup.

⚠️ **Check your CPU first.** Control Panel → Info Center → General. Several
older/entry-level models (various DS`x`j / DS`x`se) run **32-bit ARM**, which the
image doesn't cover. Intel/AMD and 64-bit ARM are fine.

**DSM 7.1 and earlier** have no Project UI — enable SSH and run
`docker compose up -d` by hand, or recreate the settings in the old Docker
package's container GUI.

## TrueNAS SCALE

Requires **24.10 "Electric Eel" or newer**. Earlier versions ran Apps on
Kubernetes and this won't apply.

- **Data path:** `/mnt/tank/appdata/yoyo-collection` (substitute your pool).
- **Create a dataset first:** Datasets → Add Dataset, **Dataset Preset: Apps**.
  Use a dedicated dataset, not a folder — it costs nothing on ZFS and it's what
  makes per-app snapshots possible.
- **Install:** Apps → Discover Apps → ⋮ → **Install via YAML**, name it
  lowercase-alphanumeric, paste into *Custom Config*.
- **Update:** Apps → Installed → Edit → Save (re-pulls `:latest`).
- **Backups:** Data Protection → **Periodic Snapshot Tasks** on that dataset,
  plus **Replication Tasks** to send them off-box. Best backup story of any
  platform here — rolling back a mistaken bulk edit becomes one click.

A ZFS snapshot taken mid-write captures a crash-consistent database, which WAL
recovers from cleanly. For a guaranteed-clean copy, stop the app first or use
the app's zip.

## QNAP

Requires **Container Station 3** (App Center).

- **Data path:** `/share/Container/yoyo-collection`
- **Create the app:** Container Station → Applications → Create, paste the YAML,
  click **Validate** before creating.
- **Update:** Applications → yoyo-collection → ⋮ → **Recreate**.
- **Backups:** **Hybrid Backup Sync (HBS 3)**. On QuTS hero (ZFS), add Snapshot
  Manager as well.

⚠️ **Check your CPU first.** Older TS-x31/x28/x32 series run **32-bit ARM**,
which the image doesn't cover.

⚠️ **The `/share/Container` symlink.** On some setups the canonical path is
`/share/CACHEDEV1_DATA/Container/...`. If the container starts but the
collection is empty on every restart, use the full `CACHEDEV` path.

## Generic Linux — Proxmox, Raspberry Pi, a VPS, any Debian/Ubuntu box

The simplest case: no appliance GUI, just Docker.

```bash
# Install Docker if needed
curl -fsSL https://get.docker.com | sh

# Somewhere on a real local disk
sudo mkdir -p /srv/appdata/yoyo-collection
cd /srv/appdata/yoyo-collection

# Save the compose file from Part 1 here, then:
sudo docker compose up -d
```

- **Data path:** anywhere on a local disk — `/srv/appdata/yoyo-collection` and
  `/opt/appdata/...` are both conventional.
- **Update:** `docker compose pull && docker compose up -d`
- **Backups:** a `cron` or systemd-timer `rsync` to another disk or host, plus
  the app's zip. On ZFS or btrfs root, snapshots work well.
- **Autostart:** `restart: unless-stopped` in the compose file handles it, as
  long as Docker itself is enabled — `sudo systemctl enable docker`.

**Proxmox:** either an LXC container or a small VM works. For LXC you need a
**privileged** container, or nesting enabled, for Docker to run — an unprivileged
LXC with nesting is the usual compromise. A VM avoids the whole question and is
worth it if you're unsure.

**Raspberry Pi:** see the [microSD rule](#on-an-sbc-raspberry-pi-odroid-etc--the-microsd-rule-) —
boot from SSD, or at minimum keep the data and Docker's storage root off the
card. A Pi 4 or 5 is comfortable; thumbnailing on anything older is slow.

**A VPS** works but reverses the LAN-only assumptions in Part 1 — it's on the
public internet by definition. Read [REMOTE-ACCESS.md](REMOTE-ACCESS.md) and set
`ADMIN_PASSWORD` and `RATE_LIMIT_MAX` before you put real data in.

**App-store wrappers** (CasaOS, ZimaOS, Umbrel, Runtipi, Dockge, Portainer) are
thin layers over the same Docker. Paste the compose file into whatever
"custom app" or "stack" form they provide; everything in Part 1 still applies.

---

## Notes / gotchas

- **Files are owned by root.** The image sets no `USER`, so everything it writes
  is root-owned. Harmless for the app; you'll need root to manage those files
  over SMB or from a file manager.

- **Run exactly one instance.** SQLite is single-writer, and the app's rate
  limiter and update cache are in-process `Map`s. This must never run at two
  replicas — which also rules out Kubernetes and anything that autoscales.

- **Restore is the memory-hungry endpoint.** Backup streams and is memory-safe;
  restore buffers the whole upload (up to 200 MB) plus the parsed archive on top.
  Fine with 4 GB+; worth knowing on a 1–2 GB entry-level unit.

- **Thumbnails after a restore.** If photos load slowly, **Settings ⚙** has an
  optimize pass that generates any that are missing.

- **`sharp` failing isn't fatal.** The Debian-slim base exists so its prebuilt
  binaries resolve. If it ever fails to load, the app boots anyway and serves
  full-size images without thumbnails, logging a warning.

- **Carrier ETA lookups** (the "Query ETA" button on Arrivals) need production
  OAuth credentials in the `environment:` block — `UPS_*`, `USPS_*`, or
  `FEDEX_*`. See [`.env.example`](.env.example). The only feature needing
  outbound internet.

- **Won't start?** Check the port isn't taken (`ss -tlnp | grep 3000`) and that
  the bind-mount path resolves to the disk you intended. Container logs are in
  your platform's GUI, or `docker logs yoyo-collection`.

---

## Going public later

You don't need a second server. Because everything public is read-only by
definition, the better path is a **static snapshot** generated from the NAS and
pushed to S3 + CloudFront — no server to patch, no login exposed, and link
previews that work *better* than the live app's, because Open Graph tags get
baked per page at build time rather than rendered per request.

That needs a small `publish.mjs` exporter and a static-mode switch in
`public/app.js`, neither of which exists yet. The critical detail when they do:
**every row must be written through `publicSafe()`** (see `server.js`) so
prices, sellers, buyers, and purchase dates stay out of the published data.

Until then, **⤓ Share card** in the detail view downloads a rendered image of a
single yoyo you can send to anyone — no exposure required.
