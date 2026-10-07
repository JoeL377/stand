# One container runs everything: the web app, the meeting WebSockets and the
# speech-to-text agent. Meetings live in SQLite under /data, which must be a
# persistent volume, so run exactly one instance.
FROM node:22-bookworm-slim
# The LiveKit agent's native WebRTC library verifies TLS against the system
# certificate store, which the slim image leaves out. Without it the agent
# can't join rooms and nothing gets transcribed.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY . .
RUN npm run build
EXPOSE 8080
CMD ["npm", "start"]
