#!/usr/bin/env bash
#
# One-command redeploy of AllDocs from your LOCAL machine to the VPS.
#
# Run from the repo root (Git Bash on Windows, or any bash):
#     bash deploy/update.sh
#
# What it does:
#   1. tars the working tree (excluding build artifacts + runtime data)
#   2. scps it to the server
#   3. extracts OVER /opt/alldocs — extraction overwrites tracked files
#      but never deletes the excluded runtime dirs (uploads/, audit/,
#      tickets/, telemetry/, venv/), so user data + the venv survive
#   4. refreshes Python deps + reinstalls/rebuilds the web app
#   5. restarts the service + health-checks
#
# The box is SHARED with livebooost.com (nginx :80/:443, a pm2 Node app on
# :5000, MongoDB in Docker) and has a single ARM core, so the heavy steps
# run under `nice` to keep that site responsive during a deploy.
#
# Override the target with env vars if your server/key differ:
#   ALLDOCS_HOST=1.2.3.4 ALLDOCS_KEY=~/.ssh/mykey bash deploy/update.sh
set -euo pipefail

HOST="${ALLDOCS_HOST:-89.168.74.108}"
KEY="${ALLDOCS_KEY:-$HOME/.ssh/livebooost_key}"
SSH_USER="${ALLDOCS_SSH_USER:-ubuntu}"
TARBALL="alldocs-deploy.$(date +%s).tar.gz"

# Functions (not string vars) so a space in $KEY / $HOME doesn't
# word-split and break the command.
ssh_run() { ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "$SSH_USER@$HOST" "$@"; }

echo "==> Packaging working tree..."
# NOTE: the Rust build dir is ./core/target, NOT ./core/udm/target. Getting
# that wrong shipped ~293 MB of build artifacts on every single deploy
# (103 MB compressed vs 751 KB). Keep both spellings excluded.
tar czf "/tmp/$TARBALL" \
  --exclude='./.git' \
  --exclude='./node_modules' \
  --exclude='./web/node_modules' \
  --exclude='./web/.next' \
  --exclude='./venv' \
  --exclude='./web/public/uploads' \
  --exclude='./audit' \
  --exclude='./tickets' \
  --exclude='./telemetry' \
  --exclude='./core/target' \
  --exclude='./core/udm/target' \
  --exclude='./target' \
  --exclude='./tests/fixtures' \
  --exclude='*/__pycache__' \
  --exclude='*.pyc' \
  .

echo "==> Uploading to $HOST..."
scp -i "$KEY" -o StrictHostKeyChecking=accept-new "/tmp/$TARBALL" "$SSH_USER@$HOST:/tmp/$TARBALL"
rm -f "/tmp/$TARBALL"

echo "==> Extracting + rebuilding on server..."
# shellcheck disable=SC2087
ssh_run bash -s <<REMOTE
set -euo pipefail
sudo tar xzf "/tmp/$TARBALL" -C /opt/alldocs
sudo rm -f "/tmp/$TARBALL"
sudo chown -R alldocs:alldocs /opt/alldocs

echo "  - python deps (only reinstalls if changed)"
sudo -u alldocs /opt/alldocs/venv/bin/pip install -q -r /opt/alldocs/deploy/requirements.txt

echo "  - web install + build"
cd /opt/alldocs/web
sudo -u alldocs env HOME=/opt/alldocs nice -n 15 pnpm install --silent
sudo -u alldocs env HOME=/opt/alldocs NODE_ENV=production nice -n 15 pnpm build

echo "  - fixing ownership"
sudo chown -R alldocs:alldocs /opt/alldocs
# nginx (www-data) serves /uploads/* straight off disk and must be able to
# traverse into the app dir.
sudo chmod 755 /opt/alldocs

echo "  - restarting service"
sudo systemctl restart alldocs
sleep 3
systemctl is-active alldocs
REMOTE

echo "==> Health check..."
sleep 1
curl -s --connect-timeout 20 https://getalldocs.com/api/health | head -c 300
echo
echo "==> Done. https://getalldocs.com is updated."
