# Setting up Hetzner and Coolify

Everything you need to do by hand, in order. Nothing here is automated because
all of it involves an account, a card or a password.

**One machine.** Production and every pull-request preview run on the same box,
which is the right shape for a hobby project with no players yet: an idle world
is about 90 MB resident, so a 4 GB server holds the live one and several
previews without noticing. The one thing that has to be right is a memory limit
per container — see step 4 — because that is what stops a runaway preview taking
production with it.

Splitting onto a second box later is a Coolify setting and a DNS record, not a
rewrite.

Total: **€6.59/month**, on one bill, with no external services.

---

## 1. The box

One server at [hetzner.com/cloud](https://www.hetzner.com/cloud). Ubuntu 24.04.

**CX23** — 2 vCPU, 4 GB, 40 GB NVMe, **€5.49/month**. Hetzner raised prices twice
in 2026 and the dedicated-vCPU lines went up hardest, so the shared-vCPU CX line
is now the cheap one; it is also currently *below* the ARM CAX11 at €5.99. Check
the console for today's number before you commit — this moved twice this year.

Either architecture works. `@tursodatabase/database` publishes
`linux-arm64-gnu`, and Coolify builds the image on the server it deploys to, so
ARM needs nothing special if the pricing flips back.

Pick a location near your players. This is the single-region latency cost the
migration accepted deliberately — one box means one place.

Add your SSH key during creation, and **enable backups** (+20%, so about €1.10).
They snapshot the whole disk, which is the cheapest possible safety net under
`stapes.db` and independent of the `VACUUM INTO` backups in step 7.

Then:

```bash
ssh root@<ip>
apt update && apt upgrade -y
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
```

Coolify comes up on `http://<ip>:8000`. Create the admin account **immediately** —
until you do, anybody who finds the port can.

---

## 2. DNS

All pointing at the one IP:

| Record | Type | Value |
| --- | --- | --- |
| `stapes.example.com` | A | the IP |
| `coolify.example.com` | A | the IP |
| `*.preview.example.com` | A | the IP |

The wildcard is what gives each pull request `pr-42.preview.example.com` without
touching DNS again.

In Coolify → **Settings → Instance Domain**, set the `coolify.*` name. Traefik
gets Let's Encrypt certificates automatically once DNS resolves, and routes by
hostname — so production and every preview share port 443 without conflicting.

---

## 3. There is no bucket

Nothing to do here — the step is left in so the numbering below still matches
anything you have half-written down.

Continuous integration posts the built client straight to the server, which
stores it on the volume under `clients/<sha>/` and flips a pointer. That is why
there is no object storage to buy, no S3 credentials, and no MinIO container
eating memory on a box you are already sharing with previews.

**A server deploy does not erase the client.** Builds are on the mounted volume,
not in the image, and the server writes down which one it is serving so a new
container comes back up on the same page. Covered by `server/clientBundle.test.ts`.

---

## 4. The production application

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
the directory anyway — WAL means `stapes.db-wal` and `stapes.db-shm` sit beside
it and have to travel with it.

Without this mount the container filesystem is ephemeral and **every deploy
silently starts a brand new world**. Nothing warns you.

### Memory limit

**Resource Limits → Memory: `1g`.**

Do not skip this on a shared box. An idle world is about 90 MB, so a gigabyte is
enormous headroom — the number matters less than the limit existing. Without one,
a container that leaks hands the problem to the kernel's OOM killer, which
chooses its victim by resident size; on a box full of small preview worlds, the
largest process is production. With a limit, the offender dies inside its own
cgroup and nothing else notices.

### Environment variables

```
DATA_DIR=/data
BACKUP_DIR=/backups
PUBLIC_ORIGIN=https://stapes.example.com
ADMIN_SECRET=<openssl rand -hex 32>
NODE_ENV=production
CHECKPOINT_INTERVAL_MS=2000
```

Five variables and one secret. `NODE_ENV=production` is what tells the server to
read authored content from the database rather than from a `data/` directory
that only exists in a checkout.

Add a second persistent storage while you are here — name `stapes-backups`,
destination `/backups`. A backup on the volume it is protecting is not a backup,
and step 7 writes there.

### Deployment settings

- **Health check path**: `/api/health`
- **Rolling deploy: OFF.** This matters more than anything else on the page. Two
  processes on one world write a board blended from two timelines, and because
  the checkpoint is preferred over the authored map on load, it persists.
  `server/lock.ts` refuses to start a second writer, so a rolling deploy does not
  corrupt anything — it just fails, repeatedly, in a way that is baffling if you
  did not mean it.

Deploy. The first boot creates the database, seeds it from the `data/` in the
image, and comes up on a world nobody has played yet. The page 404s until CI
pushes a client — that is expected.

---

## 5. GitHub

**Settings → Secrets and variables → Actions.**

Secrets:

```
ADMIN_SECRET                        same value as the box
COOLIFY_TOKEN                       Coolify → Keys & Tokens → API tokens
```

Variables:

```
PUBLIC_ORIGIN=https://stapes.example.com
COOLIFY_URL=https://coolify.example.com
COOLIFY_APP_UUID=<from the app's URL in Coolify>
COOLIFY_PREVIEW_APP_UUID=<step 6>
PREVIEW_DOMAIN=preview.example.com
MAX_PREVIEWS=4
```

Push to `main`. The client job builds, posts the archive to
`/api/client/upload`, and calls `/api/client/activate` — the page goes live
without the server restarting and without anybody being disconnected.

**The server only redeploys when a commit message contains `[server]`**, or when
you run the workflow by hand. Most commits are client-only, and restarting for
those would disconnect everybody to ship a colour.

---

## 6. Previews, on the same box

A second Coolify application, same repository, same server:

- **Domain**: `https://pr-{{pr_id}}.preview.example.com`
- **Preview deployments**: enabled
- **Memory limit**: `512m` — smaller than production on purpose. Previews are for
  looking at, and the tighter ceiling means a broken branch runs out of room
  before it can crowd the live world.
- Persistent storage `/data`, same as production. Coolify scopes the volume to
  the pull request, so each gets its own world.
- Same environment variables, except `PUBLIC_ORIGIN` (use the templated domain)
  and a **different** `ADMIN_SECRET`.

Copy the app UUID into `COOLIFY_PREVIEW_APP_UUID`.

`MAX_PREVIEWS` is enforced in the workflow before deploying, so the fifth
concurrent pull request fails with a sentence rather than by exhausting the box.
Raise it when the machine is bigger; at 90 MB a world you have far more room than
4, and the low cap is only there because nothing has measured this under real
load yet.

Open a throwaway pull request and **verify the volume is actually destroyed** on
close (`docker volume ls` before and after). A preview volume that quietly
survives is a slow disk leak whose first symptom is a full disk months later —
and on a shared box, a full disk takes production down too.

---

## 7. Backups

Hetzner's snapshots cover the disk. This covers the database on its own, which is
what you want when the problem is "somebody reset the world" rather than "the box
died".

**The server takes its own snapshot, and it has to.** It holds the database with
`PRAGMA locking_mode = EXCLUSIVE` — the same thing that stops a second process
corrupting the world — so nothing outside the container can open the file at all.
A cron job running `sqlite3` against the volume gets `database is locked` and a
backup that has never once worked. Ask the process that holds the lock:

```bash
echo "17 4 * * * root curl -fsS -X POST http://127.0.0.1:3000/api/backup -H 'Authorization: Bearer <ADMIN_SECRET>' >/dev/null" \
  >/etc/cron.d/stapes-backup
```

That writes a consistent `VACUUM INTO` snapshot to `/backups`, safe to run while
the world is being played. The deploy workflow also calls it immediately before
replacing the container, which is the copy you would actually want.

Then get them off the box — `rclone`, `scp` to somewhere else, anything. **A
backup on the machine it is protecting is not a backup**, and that is more true
now that one machine holds everything. Prune what you keep:

```bash
find /var/lib/docker/volumes/*stapes-backups*/_data -name 'stapes-*.db' -mtime +30 -delete
```

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
while standing in the world. You should see it pause for a couple of seconds and
come back **with you where you were standing** — not at spawn, and not on an
error screen. That is the whole migration working: if position survives a deploy,
the checkpoint, the drain and the reconnect are all correct.

Reset the world if you ever need to (destroys every position, kit, reward and
mastery):

```bash
curl -X POST https://stapes.example.com/api/reset \
  -H "Authorization: Bearer $ADMIN_SECRET"
```

---

## What it costs

| | Monthly |
| --- | --- |
| CX23 | €5.49 |
| Hetzner backups (20%) | €1.10 |
| **Total** | **€6.59** |

One line item. Nothing else is bought, and nothing outside Hetzner is depended
on.

Hetzner adjusted prices twice in 2026, so check the console rather than trusting
this table. When one box stops being enough, the first thing to move off is
previews: a second server, the same Coolify application pointed at it, and one
DNS record.
