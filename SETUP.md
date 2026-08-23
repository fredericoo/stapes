# Setting up Hetzner and Coolify

Everything you need to do by hand, in order. Nothing here is automated because
all of it involves an account, a card or a password.

The end state is two Hetzner boxes — **prod** and **preview** — each running
Coolify, plus one S3-compatible bucket holding client builds. There is no
database server to run: the world is a file on a volume.

---

## 1. The boxes

Two servers at [hetzner.com/cloud](https://www.hetzner.com/cloud). Ubuntu 24.04,
in a location near you (Falkenstein or Helsinki for Europe, Ashburn or Hillsboro
for the US — this is the single-region latency cost the migration accepted, so
pick for your players rather than for yourself).

| | Type | Why |
| --- | --- | --- |
| **prod** | CPX21 — 3 vCPU, 4 GB, 80 GB | The world is held in memory. 4 GB is roomy for one; 2 GB would also do until it is not, and finding out costs an outage. |
| **preview** | CPX31 — 4 vCPU, 8 GB, 160 GB | Every open pull request is a whole world **and** its client bundle. Budget ~300 MB each and cap the count. |

Add your SSH key during creation. **Enable backups** (20% surcharge) — they are
snapshots of the whole disk, which is the cheapest possible safety net under the
`stapes.db` file, and independent of the `VACUUM INTO` backups below.

Then, on each box:

```bash
ssh root@<ip>
apt update && apt upgrade -y
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
```

Coolify comes up on `http://<ip>:8000`. Create the admin account **immediately** —
until you do, anybody who finds the port can.

---

## 2. DNS

At your registrar, pointing at the two boxes:

| Record | Type | Value |
| --- | --- | --- |
| `stapes.example.com` | A | prod IP |
| `coolify.example.com` | A | prod IP |
| `*.preview.example.com` | A | preview IP |
| `coolify-preview.example.com` | A | preview IP |

The wildcard is what lets each pull request have `pr-42.preview.example.com`
without touching DNS again.

In Coolify → **Settings → Instance Domain**, set the `coolify.*` name. Traefik
gets Let's Encrypt certificates automatically once DNS resolves.

---

## 3. The bucket

Hetzner Object Storage, in the **same location as the prod box**. It is read once
per deploy rather than per request, so this barely matters for speed — but same-
region keeps it on one bill and one network.

Create a bucket named `stapes-client`, then generate S3 credentials (Hetzner
Console → Object Storage → Credentials). Keep the endpoint URL; it looks like
`https://fsn1.your-objectstorage.com`.

Nothing about the *world* goes here. Only built client files.

---

## 4. The prod application

Coolify → **New Resource → Public Repository** (or connect GitHub), pointing at
this repository.

- **Build pack**: Dockerfile
- **Branch**: `main`
- **Domain**: `https://stapes.example.com`
- **Port**: `3000`

### Persistent storage

**Storages → Add**, and this is the one setting that silently loses the world if
it is wrong:

- Name: `stapes-data`
- Destination path: `/data`

**Mount the directory, not the file.** Pointing Coolify's persistent storage at
`/data/stapes.db` directly is a known bug
([coolify#5337](https://github.com/coollabsio/coolify/issues/5337)), and you want
the directory regardless — WAL means `stapes.db-wal` and `stapes.db-shm` sit
beside it and have to travel with it.

Without this mount the container filesystem is ephemeral and **every deploy
silently starts a brand new world**. Nothing warns you.

### Environment variables

```
DATA_DIR=/data
PUBLIC_ORIGIN=https://stapes.example.com
ADMIN_SECRET=<openssl rand -hex 32>
CLIENT_BUCKET=stapes-client
CLIENT_BUCKET_ENDPOINT=https://fsn1.your-objectstorage.com
CLIENT_BUCKET_REGION=fsn1
CLIENT_BUCKET_ACCESS_KEY_ID=<from step 3>
CLIENT_BUCKET_SECRET_ACCESS_KEY=<from step 3>
CHECKPOINT_INTERVAL_MS=2000
```

`CLIENT_BUILD_ID` is left unset on the first deploy — there is no build in the
bucket yet. CI sets it from then on.

### Deployment settings

- **Health check path**: `/api/health`
- **Rolling deploy: OFF.** This matters more than anything else on the page. Two
  processes on one world write a board blended from two timelines, and because
  the checkpoint is preferred over the authored map on load, it persists.
  `server/lock.ts` refuses to start a second writer, so a rolling deploy does
  not corrupt anything — it just fails, repeatedly, in a way that is confusing
  if you did not mean it.

Deploy. The first boot creates the database, seeds it from the `data/` in the
image, and comes up on a world nobody has played yet. The page will 404 until CI
pushes a client — that is expected.

---

## 5. GitHub

**Settings → Secrets and variables → Actions.**

Secrets:

```
ADMIN_SECRET                        same value as the box
CLIENT_BUCKET_ACCESS_KEY_ID
CLIENT_BUCKET_SECRET_ACCESS_KEY
COOLIFY_TOKEN                       Coolify → Keys & Tokens → API tokens
```

Variables:

```
PUBLIC_ORIGIN=https://stapes.example.com
CLIENT_BUCKET=stapes-client
CLIENT_BUCKET_ENDPOINT=https://fsn1.your-objectstorage.com
CLIENT_BUCKET_REGION=fsn1
COOLIFY_URL=https://coolify.example.com
COOLIFY_APP_UUID=<from the app's URL in Coolify>
COOLIFY_PREVIEW_APP_UUID=<step 6>
PREVIEW_DOMAIN=preview.example.com
```

Push to `main`. The client job builds, pushes to `builds/<sha>/`, and calls
`/api/client/activate` — the page is live without the server having restarted.

**The server only redeploys when a commit message contains `[server]`**, or when
you run the workflow by hand. Most commits are client-only, and restarting for
those would disconnect everybody to ship a colour.

---

## 6. The preview application

On the **preview** Coolify, the same repository again:

- **Domain**: `https://pr-{{pr_id}}.preview.example.com`
- Same environment variables, except `PUBLIC_ORIGIN` (use the templated domain)
  and a **different** `ADMIN_SECRET`
- **Preview deployments: enabled**
- Persistent storage `/data`, same as prod

Coolify creates a container and volume per pull request and destroys both when
it closes. Copy the app UUID into `COOLIFY_PREVIEW_APP_UUID`.

Open a throwaway pull request and **verify the volume is actually destroyed** on
close (`docker volume ls` on the preview box, before and after). A preview volume
that quietly survives is a slow disk leak whose first symptom is a full disk six
months later.

---

## 7. Backups

Hetzner's snapshots cover the disk. This covers the database on its own, which is
what you want when the problem is "somebody reset the world", not "the box died".

On the prod box:

```bash
cat >/usr/local/bin/stapes-backup <<'SH'
#!/bin/bash
set -euo pipefail
VOLUME=$(docker volume ls -q | grep stapes-data | head -1)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
# VACUUM INTO takes a consistent snapshot of a live database — safe to run
# while the world is being played, which is the point of using it over `cp`.
docker run --rm -v "$VOLUME":/data -v /var/backups/stapes:/out oven/bun:1.3.8-slim \
  bun -e "const {connect}=await import('@tursodatabase/database');const db=await connect('/data/stapes.db');await db.exec(\"VACUUM INTO '/out/stapes-$STAMP.db'\")"
find /var/backups/stapes -name 'stapes-*.db' -mtime +30 -delete
SH
chmod +x /usr/local/bin/stapes-backup
mkdir -p /var/backups/stapes
echo "17 4 * * * root /usr/local/bin/stapes-backup" >/etc/cron.d/stapes-backup
```

Push `/var/backups/stapes` off the box — to the same object storage, or anywhere
else. **A backup on the machine it is protecting is not a backup.**

If a nightly window is ever too coarse, [Litestream](https://litestream.io)
streams the write-ahead log continuously for near point-in-time recovery, as a
single sidecar binary.

---

## 8. Checking it works

```bash
curl https://stapes.example.com/api/health
# {"status":"ok","players":0,"build":"<sha>"}
```

Then open the site, join `/online`, and redeploy the server by hand from Coolify
while you are standing in the world. You should see the world pause for a couple
of seconds and come back with you where you were standing — not at spawn, and
not on an error screen. **That is the whole migration working**; if position
survives a deploy, the checkpoint, the drain and the reconnect are all correct.

Reset the world, if you ever need to (destroys every position, kit, reward and
mastery):

```bash
curl -X POST https://stapes.example.com/api/reset \
  -H "Authorization: Bearer $ADMIN_SECRET"
```

---

## Rough cost

| | Monthly |
| --- | --- |
| prod CPX21 | €8 |
| preview CPX31 | €15 |
| Backups (20%) | €5 |
| Object storage | €5 |
| **Total** | **~€33** |
