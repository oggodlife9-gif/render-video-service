# Use Node 18 LTS
FROM node:18-bullseye

# Install FFmpeg and other system deps
RUN apt-get update && \
    apt-get install -y ffmpeg curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Create app dir
WORKDIR /usr/src/app

# Install deps first (better caching)
COPY package*.json ./
RUN npm install --production

# Copy source
COPY server.js ./

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:${PORT:-3000}/health || exit 1

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
