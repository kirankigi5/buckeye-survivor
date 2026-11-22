# The match runs this with no network, a read-only root (writable /tmp), 1 CPU, 512 MB, and the map at /arena.
FROM oven/bun:1.4.4-slim
WORKDIR /bot
COPY . .
# Continue strafing during reloads instead of detouring for cover.
ENV MF_NOCOVER=1
ENTRYPOINT ["bun", "/bot/bot.ts"]
