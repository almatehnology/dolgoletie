#!/bin/sh
set -e

# Используем локально установленный Prisma CLI напрямую через node,
# иначе `npx prisma` без .bin-симлинка тянет latest из npm (7.x),
# который несовместим с нашей моделью (убрали datasource.url).
PRISMA="node /app/node_modules/prisma/build/index.js"

echo "[entrypoint] Применяю миграции Prisma..."
$PRISMA migrate deploy || {
  echo "[entrypoint] migrate deploy не удался, пробую prisma db push..."
  $PRISMA db push --accept-data-loss=false
}

echo "[entrypoint] Запуск: $@"
exec "$@"
