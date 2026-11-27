# Stage 1: Build the React client
FROM node:22-alpine AS builder

WORKDIR /app
COPY client/package*.json ./client/
RUN cd client && npm ci

COPY client/ ./client/
RUN npm run build --prefix client

# Stage 2: Production environment
FROM node:22-alpine

# Install ffmpeg and optional yt-dlp fallback for YouTube/Kick stream extraction
RUN apk add --no-cache ffmpeg yt-dlp

WORKDIR /app

# Copy backend dependencies and install without lifecycle scripts; system ffmpeg/ffprobe come from apk
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && rm -rf node_modules/ffprobe-static/bin node_modules/ffmpeg-static/ffmpeg* && npm cache clean --force

# Copy backend source code (kept root-owned so runtime node user cannot modify source)
COPY server.js check.js get-stream.js record.js ./
COPY lib/ ./lib/
COPY routes/ ./routes/

# Copy the built client from Stage 1
COPY --from=builder /app/client/dist ./client/dist

# Ensure /app (for runtime db/config creation) and /app/recordings are writable by node, while source subdirs remain root-owned
RUN mkdir -p recordings/highlights recordings/thumbs recordings/audio && chown node:node /app && chown -R node:node /app/recordings

USER node

# Bind to all network interfaces so it's accessible outside the container
ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
