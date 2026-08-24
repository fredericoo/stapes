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

Add your SSH key during creation.

**Hetzner's own backups are +20% and are off on this deployment.** They snapshot
the whole disk, which is the only thing that survives the disk itself failing —
so with them off, the world's durability rests entirely on step 7's snapshots
*and on those being copied off the box*. A `VACUUM INTO` file sitting on the
volume it was taken from protects against a bad reset, not a dead server. If the
world ever stops being disposable, this is the first €1.32 to spend.

Then:

```bash
ssh root@<ip>
apt update && apt upgrade -y
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
```

Coolify comes up on `http://<ip>:8000`. Create the admin account **immediately** —
until you do, anybody who finds the port can.

---

## 2. DNS and Cloudflare

All pointing at the one IP:

| Record | Type | Value |
| --- | --- | --- |
| `stapes.example.com` | A | the IP |
| `coolify.example.com` | A | the IP |
| `*.preview.example.com` | A | the IP |

The wildcard is what gives each pull request `pr-42.preview.example.com` without
touching DNS again.

The Coolify panel needs its own route, and setting the instance domain in the
UI is **not** enough. Coolify labels the containers it deploys, but its own
container is created by the installer's compose file and carries no Traefik
labels — so the panel stays on plain HTTP no matter what the setting says. The
route is declared instead in
`/data/coolify/proxy/dynamic/coolify-panel.yaml`, which also puts it out of
reach of anything Coolify rewrites later.

Close the plaintext port once HTTPS works, or the fix is decorative — anyone
with the IP can still log in over `http://<ip>:8000`:

```bash
iptables -I DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 8000 -j DROP
netfilter-persistent save
```

Three things about that rule, each of which cost an attempt:

- **`DOCKER-USER`, not `INPUT` or `ufw`.** Docker inserts its own rules ahead of
  those, so a published port ignores them entirely.
- **`--ctorigdstport 8000`, not `--dport 8000`.** Docker has already rewritten
  the destination to the container's port by the time the filter chains see the
  packet, so matching the published port never fires.
- **Match `--ctorigdstport`, not the container's address.** A rule naming
  `10.0.1.x` stops matching the moment the container is recreated, and the admin
  port reopens with nothing to say so.

Loopback is deliberately untouched, so `ssh -L 8000:localhost:8000 root@<ip>`
is still a way in if the HTTPS route ever breaks.

In Coolify → **Settings → Instance Domain**, set the `coolify.*` name. Traefik
gets Let's Encrypt certificates automatically once DNS resolves, and routes by
hostname — so production and every preview share port 443 without conflicting.

### Which records are proxied, and why it matters

- **`stapes.frederic.ooo` is orange (proxied), SSL/TLS mode Full (strict).**
  Cloudflare gives it a hidden origin IP, bot and DDoS filtering, and edge
  caching for the content-hashed client assets — which is the CDN this
  single-region deployment otherwise gives up. WebSockets pass through it fine;
  verified with a live `wss://` handshake.
- **Everything else stays grey.** The Coolify panel gains nothing from being
  proxied, and `next.stapes` needs an unobstructed ACME renewal.

**Never use Flexible.** It sends Cloudflare→origin in plaintext, so the traffic
is encrypted for only half its journey, and the origin would see `http` and stop
marking the actor cookie `Secure`.

**Delete stale AAAA records when you repoint a hostname.** An `AAAA` left
pointing at Cloudflare while the `A` moved to the box made Let's Encrypt fail
issuance: it preferred IPv6, reached Cloudflare, and got a 404 for the challenge.
The error names a `2606:4700:…` address, which is the tell.

### On Cloudflare Origin Certificates

There is one installed at `/data/coolify/proxy/certs/`, and Traefik is **not**
using it. Coolify attaches an ACME resolver to the router, which wins for the
same hostname, and stripping that would be undone by the next deploy.

It is not needed. The renewal risk it insures against — Cloudflare masking a
failed renewal until the certificate lapses — was checked rather than assumed:
ACME challenges reach the origin through the proxy, so Let's Encrypt renews
normally. The deploy workflow warns when the origin certificate is inside three
weeks of expiry, which is the cheaper version of the same insurance.

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
ADMIN_SECRET                        same value as the production app's env
PREVIEW_ADMIN_SECRET                same value as the preview app's env, step 6
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
ORIGIN_IP=<the box's address>
```

`PUBLIC_ORIGIN` is where continuous integration posts the built client, so point
it at a name that reaches the box **directly**. Behind Cloudflare the upload
inherits the proxy's body-size and request-time limits for no benefit — nothing
about this step wants a CDN. It is also the host the deploy's certificate-expiry
warning inspects, so a grey name reports on Traefik's own renewal.

`ORIGIN_IP` is only read by that warning, which connects by address so it sees
what the origin serves rather than what Cloudflare serves.

Push to `main` and both halves deploy. There are no players yet, so a couple of
seconds of downtime per merge costs nothing and buys a pipeline nobody has to
think about.

The order in `deploy.yml` is the one thing worth knowing: it uploads the client
*without activating it*, restarts the server, waits for health, and only then
activates. Uploading is inert and the files survive the restart on the volume,
so this keeps a `PROTOCOL_VERSION` bump survivable — the other order puts a new
client in front of an old server and every tab reload-loops until they match.

`workflow_dispatch` is on the same workflow, so you can redeploy from GitHub's
mobile app or with `gh workflow run deploy.yml` without an empty commit.

---

## 6. Previews, on the same box

**Previews need Coolify connected to GitHub as a source** — a GitHub App under
Coolify → Sources, installed on this repository — and this is not optional the
way it looks. Coolify's deploy API cannot start a preview: `POST /api/v1/deploy`
with `pr=N` only *looks up* a preview record and answers `Pull request N not
found for this resource` when there is none, and the only things that create one
are the pull-request webhook and the button in the UI (which itself calls the
GitHub API through the source). A deploy-key application has no source, so it
has no way to get its first preview.

That is why the workflow does not deploy previews. The webhook creates and
deploys them on `opened` and `synchronize`, destroys them on `closed`, and
`preview.yml` only builds and posts the client.

The one thing to turn off afterwards: the production application must **not** be
bound to that source, or a push to its branch deploys it behind CI's back and
races `deploy.yml`. Leaving production on its deploy key is what keeps the two
apart — a GitHub App's webhook only matches applications whose source is that
app.

**Create the preview application against the GitHub App from the start.** An
existing application cannot be moved onto one: `PATCH /applications/{uuid}` with
a `github_app_uuid` answers `422 {"github_app_uuid":["This field is not
allowed."]}`, even though the field is in its schema. There is nothing to do but
delete it and post it again to `/applications/private-github-app`, and deletion
is queued rather than immediate — the domain stays claimed for a few seconds
after the call returns, so a recreate that races it fails on a domain conflict.

`git_repository` changes shape with the source, too: `owner/repo` for a GitHub
App, the `git@github.com:owner/repo.git` URL for a deploy key.

A second Coolify application, same repository, same server:

- **Domain**: `https://pr-{{pr_id}}.preview.example.com`
- **Preview deployments**: enabled
- **Memory limit**: `512m` — smaller than production on purpose. Previews are for
  looking at, and the tighter ceiling means a broken branch runs out of room
  before it can crowd the live world.
- Persistent storage `/data`, same as production. Coolify scopes the volume to
  the pull request, so each gets its own world.
- Same environment variables, except `PUBLIC_ORIGIN` (any `https://` name under
  the preview domain — the server only reads its scheme, to decide whether the
  actor cookie is marked `Secure`) and a **different** `ADMIN_SECRET`, which
  goes into `PREVIEW_ADMIN_SECRET`.
- **Never deploy the base application.** Only its `pr-N` children are wanted;
  the parent exists to hold the settings and to give `{{domain}}` a value.

Copy the app UUID into `COOLIFY_PREVIEW_APP_UUID`.

**A preview builds its own client.** The client is not in the image, so a
container that is merely deployed comes up healthy and serves a 404 — see
`Dockerfile`. `preview.yml` therefore does the same three steps `deploy.yml`
does: it waits for the world to answer `/api/health`, posts the build to
`/api/client/upload`, and activates it. That is what `PREVIEW_ADMIN_SECRET` is
for, and it is why the workflow is slower than a deploy call.

`MAX_PREVIEWS` is a **warning, not a gate**. It used to be a gate, back when the
workflow was the thing that started previews; now the webhook does, and the
container is already coming up by the time any job could object. What actually
bounds the box is the memory limit above — that is the number to trust, and the
one that keeps a crowded box from taking production with it. Raise the warning
threshold when the machine is bigger; at 90 MB a world there is far more room
than 4, and the low number is only there because nothing has measured this under
real load yet.

### Closing a pull request does not delete its volume

It looks like it does. The container goes, the hostname stops answering, and
Coolify reports the preview destroyed — but the volume is still there, holding
that world, forever.

This is Coolify 4.3.10 itself, not a setting: `DeleteResourceJob::handle`
returns early for an `ApplicationPreview` into `deleteApplicationPreview`, which
cancels deployments, removes the containers and force-deletes the record, and
never reaches the `deleteVolumes` branch — whose `true` default only ever
applied to the resource types it returned before. Measured here at roughly 6 MB
per closed pull request, which is slow enough that the first symptom would be a
full disk months later, on a box where a full disk takes production with it.

So the box prunes them. The script is `scripts/prune-preview-volumes.sh` in this
repository — it lives here rather than only on the server so the reasoning is
reviewable and the guards are not something a future reader has to reconstruct
from a file they found in `/usr/local/bin`:

```bash
scp scripts/prune-preview-volumes.sh root@<ip>:/usr/local/bin/stapes-prune-preview-volumes.sh
ssh root@<ip> 'chmod 755 /usr/local/bin/stapes-prune-preview-volumes.sh &&
  echo "23 4 * * * root /usr/local/bin/stapes-prune-preview-volumes.sh >/dev/null" \
  > /etc/cron.d/stapes-preview-volumes'
```

Three guards, each ruling out a different way it could eat something live: the
preview application's uuid prefix, a `-pr-N` suffix, and
dangling-and-over-a-day-old. Together they cannot match production, cannot match
the preview application's own base volume, and cannot catch the seconds-long
window in which a redeploying preview has let go of its volume. **The uuid in it
is the preview application's**, so it has to be changed if that application is
ever recreated — which is exactly what happened once already, when the app had
to be rebuilt against the GitHub App source.

**Do not reach for Coolify's `delete_unused_volumes` instead.** It prunes every
unused volume on the server, and production's data *and* its backups are both
detached for about fifteen seconds while a deploy replaces the container. A
deploy landing on the nightly cleanup would take the world and every backup of
it in the same sweep.

Worth re-checking after a Coolify upgrade — if upstream starts deleting preview
volumes, this becomes a no-op rather than a conflict, but the note should go.

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

Prices below are **gross** — what actually leaves your account. Hetzner's site
and most blog posts quote net, which is where the widely-repeated €5.49 comes
from; the API returns both.

| | net | gross |
| --- | --- | --- |
| CX23, Falkenstein | €5.49 | **€6.59** |
| Hetzner backups (+20%, off here) | €1.10 | €1.32 |
| **Total as deployed** | €5.49 | **€6.59** |

Billed hourly at €0.0106 gross, so destroying the server stops the cost the same
hour.

One line item. Nothing else is bought, and nothing outside Hetzner is depended
on.

Hetzner adjusted prices twice in 2026, so check the console rather than trusting
this table. When one box stops being enough, the first thing to move off is
previews: a second server, the same Coolify application pointed at it, and one
DNS record.
