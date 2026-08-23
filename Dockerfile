# The game server. One process: the world, the API, and the client bundle.
#
# The client is *not* built into this image. It is pushed to a bucket by CI and
# loaded at boot, which is the whole point of the split — a UI change ships
# without restarting the process or disconnecting anybody.
FROM oven/bun:1.3.8-slim AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
# `--frozen-lockfile` so a lockfile that disagrees with the manifest fails the
# build rather than silently resolving something else.
RUN bun install --frozen-lockfile --production

FROM base AS runtime
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY app ./app
# Authored content travels in the image so a fresh deployment builds its own
# world on first boot with nothing to provision. See `server/seed.ts`.
COPY data ./data

# The database and its WAL sidecars. Mounted as a volume in production — the
# directory, never the file, since the sidecars must travel with it and Coolify
# errors when pointed at a single file.
ENV DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 3000

# The healthcheck is what takes a draining container out of rotation before its
# sockets close, so it has to fail while draining rather than merely report it.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:'+(process.env.PORT??3000)+'/api/health'); const b = await r.json(); process.exit(b.status === 'ok' ? 0 : 1)"

# Exec form, so the process is PID 1 and receives SIGTERM directly. Through a
# shell it would not, the drain would never run, and every deploy would lose up
# to a checkpoint interval of play.
CMD ["bun", "run", "server/index.ts"]
