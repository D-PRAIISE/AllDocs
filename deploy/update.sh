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
# Override the target with env vars if your server/key differ:
#   ALLDOCS_HOST=1.2.3.4 ALLDOCS_KEY=~/.ssh/mykey bash deploy/update.sh
set -euo pipefail

HOST="${ALLDOCS_HOST:-167.233.29.231}"
KEY="${ALLDOCS_KEY:-$HOME/.ssh/alldocs_hetzner}"
TARBALL="alldocs-deploy.$(date +%s).tar.gz"

# Functions (not string vars) so a space in $KEY / $HOME doesn't
# word-split and break the command.
ssh_run() { ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "root@$HOST" "$@"; }

echo "==> Packaging working tree..."
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
  --exclude='./core/udm/target' \
  --exclude='./target' \
  --exclude='./tests/fixtures/tessdata' \
  --exclude='*/__pycache__' \
  --exclude='*.pyc' \
  .

echo "==> Uploading to $HOST..."
scp -i "$KEY" -o StrictHostKeyChecking=accept-new "/tmp/$TARBALL" "root@$HOST:/tmp/$TARBALL"
rm -f "/tmp/$TARBALL"

echo "==> Extracting + rebuilding on server..."
# shellcheck disable=SC2087
ssh_run bash -s <<REMOTE
set -euo pipefail
tar xzf "/tmp/$TARBALL" -C /opt/alldocs
rm -f "/tmp/$TARBALL"

echo "  - python deps (only reinstalls if changed)"
/opt/alldocs/venv/bin/pip install -q -r /opt/alldocs/deploy/requirements.txt

echo "  - web install + build"
cd /opt/alldocs/web
pnpm install --silent
pnpm build

echo "  - fixing ownership"
chown -R alldocs:alldocs /opt/alldocs

echo "  - restarting service"
systemctl restart alldocs
sleep 3
systemctl is-active alldocs
REMOTE

echo "==> Health check..."
sleep 1
curl -s --connect-timeout 20 https://getalldocs.com/api/health | head -c 300
echo
echo "==> Done. https://getalldocs.com is updated."
