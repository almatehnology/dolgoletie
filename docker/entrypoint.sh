#!/bin/sh
set -e

echo "[entrypoint] Применяю миграции Prisma..."
npx prisma migrate deploy || {
  echo "[entrypoint] migrate deploy не удался, пробую prisma db push..."
  npx prisma db push --accept-data-loss=false
}

echo "[entrypoint] Запуск: $@"
exec "$@"
