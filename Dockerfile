# Edge worker (src/edge.js) for an always-on host in Toronto: relays BetMGM to the cloud server when the cloud's own
# browser session is refused (BetMGM answers 403 to Render's US IP). No inbound ports: it only opens a WebSocket out.
FROM mcr.microsoft.com/playwright:v1.49.1-noble
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY tools/install-transport.mjs ./tools/
RUN npm ci --omit=dev
COPY src ./src
COPY tools/probe-mgm.mjs ./tools/
CMD ["node", "src/edge.js"]
