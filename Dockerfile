# Stage 1: Build the React client
FROM node:20-alpine AS builder

WORKDIR /app
COPY client/package*.json ./client/
RUN cd client && npm ci

COPY client/ ./client/
RUN npm run build --prefix client

# Stage 2: Production environment
FROM node:20-alpine

# Install ffmpeg for recording/transcoding
RUN apk add --no-cache ffmpeg

WORKDIR /app

# Copy backend dependencies and install
COPY package*.json ./
RUN npm ci --omit=dev

# Copy backend source code
COPY server.js check.js get-stream.js record.js ./
COPY lib/ ./lib/
COPY routes/ ./routes/

# Copy the built client from Stage 1
COPY --from=builder /app/client/dist ./client/dist

# Ensure the recordings directory exists
RUN mkdir -p recordings/highlights

# Bind to all network interfaces so it's accessible outside the container
ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
