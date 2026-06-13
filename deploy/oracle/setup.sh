#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/MistGG/odyssey-discord-bot.git}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/odyssey-discord-bot}"
SERVICE_NAME="odyssey-discord-bot"

echo "==> Installing system packages (git, curl)..."
sudo apt-get update -qq
sudo apt-get install -y git curl ca-certificates

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p "process.versions.node.split('.')[0]")" -lt 20 ]]; then
  echo "==> Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "==> Node $(node -v), npm $(npm -v)"

if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "==> Updating existing repo at $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only
else
  echo "==> Cloning $REPO_URL"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
echo "==> Installing dependencies and building..."
npm ci
npm run build

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo ""
  echo "Created $INSTALL_DIR/.env from template."
  echo "Edit it with your Discord token before starting the bot:"
  echo "  nano $INSTALL_DIR/.env"
  echo ""
fi

echo "==> Installing systemd service..."
sudo cp deploy/oracle/odyssey-discord-bot.service "/etc/systemd/system/${SERVICE_NAME}.service"
sudo sed -i "s|__INSTALL_DIR__|${INSTALL_DIR}|g" "/etc/systemd/system/${SERVICE_NAME}.service"
sudo sed -i "s|__USER__|${USER}|g" "/etc/systemd/system/${SERVICE_NAME}.service"

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"

if grep -q '^DISCORD_BOT_TOKEN=.\+' .env 2>/dev/null && grep -q '^DISCORD_CLIENT_ID=.\+' .env; then
  sudo systemctl restart "$SERVICE_NAME"
  echo "==> Bot started."
else
  echo "==> Fill in .env, then run: sudo systemctl restart $SERVICE_NAME"
fi

sudo systemctl status "$SERVICE_NAME" --no-pager || true

echo ""
echo "Useful commands:"
echo "  sudo systemctl status $SERVICE_NAME"
echo "  sudo journalctl -u $SERVICE_NAME -f"
echo "  cd $INSTALL_DIR && git pull && npm ci && npm run build && sudo systemctl restart $SERVICE_NAME"
