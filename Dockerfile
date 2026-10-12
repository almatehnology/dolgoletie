ARG NODE_VERSION=22-alpine

FROM node:${NODE_VERSION} AS deps
WORKDIR /app
# Native SQLite encryption bindings are compiled during npm ci.
RUN apk add --no-cache libc6-compat openssl python3 make g++
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci

FROM node:${NODE_VERSION} AS build
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx prisma generate
RUN npm run build

FROM node:${NODE_VERSION} AS runtime
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl tini
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

COPY --from=build /app/public ./public
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/prisma/migrations ./prisma/migrations
COPY --from=build /app/package.json ./package.json
# Шрифты для PDF — используются server-side через абсолютный путь от process.cwd().
COPY --from=build /app/assets ./assets
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
# Обёртка: загружает .env через @next/env (парсит \$ корректно) и запускает server.js.
COPY docker/start.js ./start.js
RUN chmod +x /usr/local/bin/entrypoint.sh && mkdir -p /app/data /app/uploads

# Persisted directories are supplied by the operator via bind mounts.
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "start.js"]
