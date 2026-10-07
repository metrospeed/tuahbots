#!/usr/bin/env bash
# Dump the database (transcripts, users, tasks) to ./backups. Add to cron, e.g.
#   0 3 * * * /opt/tuahbots/deploy/backup.sh
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
docker compose exec -T db pg_dump -U tuah tuah | gzip > "backups/tuah-$(date +%F).sql.gz"
find backups -name 'tuah-*.sql.gz' -mtime +30 -delete
