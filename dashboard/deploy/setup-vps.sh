#!/usr/bin/env bash
# ==============================================================================
# Hydraulic System - Ubuntu/Debian VPS Automated Setup Script
# Usage:
#   chmod +x setup-vps.sh
#   sudo ./setup-vps.sh
# ==============================================================================

set -euo pipefail

echo "============================================================"
echo " Starting Hydraulic System VPS Setup"
echo "============================================================"

# 1. Update system packages
echo "[1/6] Updating system packages..."
apt-get update -y
apt-get install -y curl wget git build-essential ufw sqlite3

# 2. Install Node.js 20 LTS (if not installed)
if ! command -v node &> /dev/null; then
    echo "[2/6] Installing Node.js 20 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
else
    echo "[2/6] Node.js is already installed: $(node -v)"
fi

# 3. Install PM2 globally
if ! command -v pm2 &> /dev/null; then
    echo "[3/6] Installing PM2 process manager..."
    npm install -g pm2
fi

# 4. Setup Firewall (UFW)
echo "[4/6] Configuring firewall rules (SSH, HTTP, HTTPS)..."
ufw allow OpenSSH || true
ufw allow 80/tcp || true
ufw allow 443/tcp || true
ufw --force enable || true

# 5. Project Dependencies
echo "[5/6] Installing application dependencies..."
cd "$(dirname "$0")/.."
npm install --omit=dev

# 6. PM2 Startup Configuration
echo "[6/6] Configuring PM2 process..."
mkdir -p logs
pm2 start ecosystem.config.js --env production || pm2 restart hydraulic-system
pm2 save
pm2 startup systemd -u "$(whoami)" --hp "$HOME" || true

echo "============================================================"
echo " Setup Completed Successfully!"
echo " Hydraulic System is running via PM2."
echo " Check status with: pm2 status"
echo " View logs with  : pm2 logs hydraulic-system"
echo "============================================================"
