#!/bin/sh
set -e

# Runtime applies migrations through the cipher driver after user unlock.
# Plain Prisma CLI must not open an encrypted vault during startup.
exec "$@"
