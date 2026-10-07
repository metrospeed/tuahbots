#!/usr/bin/env bash
# One-time setup on a fresh Ubuntu droplet. Run as root:
#   curl -fsSL https://raw.githubusercontent.com/<you>/tuahbots/main/deploy/setup-droplet.sh | bash
# or copy this file over and run it.
set -euo pipefail

if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi

ufw allow OpenSSH || true
ufw allow 80/tcp || true
ufw allow 443/tcp || true
ufw allow 443/udp || true
ufw --force enable || true

echo "Docker installed. Next:"
echo "  git clone <your repo> /opt/tuahbots && cd /opt/tuahbots"
echo "  cp .env.example .env && nano .env"
echo "  docker compose up -d --build"
