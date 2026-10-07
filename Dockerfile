# One container runs everything: the web app, the meeting WebSockets and the
# speech-to-text agent. Meetings live in SQLite under /data, which must be a
# persistent volume, so run exactly one instance.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY . .
RUN npm run build
EXPOSE 8080
CMD ["npm", "start"]
