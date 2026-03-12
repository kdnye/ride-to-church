# Build frontend assets, then run server with production-only dependencies.
FROM node:20-alpine

WORKDIR /app

# Install dependencies (including dev deps for Vite build)
COPY package*.json ./
RUN npm install

# Copy source and build the client bundle
COPY . .
RUN npm run build:client

# Remove dev dependencies after build to keep image lean
RUN npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["npm", "run", "start:prod"]
