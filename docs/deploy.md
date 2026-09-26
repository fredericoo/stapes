# Deploy

- `DATA_DIR` must be mounted as a directory: the WAL and SHM files sit beside `stapes.db`, and Coolify's persistent storage fails on a single file (coolify#5337).
- The `Dockerfile` installs `curl` because Coolify's healthcheck runs inside the container with `curl` or `wget`, and the slim `oven/bun` image has neither. Without it every deploy is marked unhealthy and rolled back.
- `CMD` is exec form so Bun is PID 1 and receives `SIGTERM`. Through a shell, `World.drain` never runs and a deploy loses up to a checkpoint interval of play.
- `docker-compose.yml` sets `mem_limit` because production and every preview share one box, and without a per-container limit the OOM killer picks the largest process, which is usually production.
- `deploy.yml` and `preview.yml` wait on Coolify's deployment record, not `/api/health`. Coolify's deploy API returns when the deploy is queued, and the old container answers `/api/health` until it is replaced.
- `deploy.yml` uploads the client, deploys the server, then activates the client. Activating first puts a client with a new `PROTOCOL_VERSION` in front of the old server, and every tab reloads into the same mismatch.
- `scripts/prune-preview-volumes.sh` deletes preview volumes because Coolify 4.3.10 does not when a PR closes. Its three guards (preview app UUID prefix, `-pr-N` suffix, dangling for over a day) keep it off production and backup volumes, which are briefly dangling during a normal deploy; Coolify's `delete_unused_volumes` would match them.
