# Deploying AllDocs (VPS + Cloudflare)

AllDocs runs on a small Linux VPS. Cloudflare (where `getalldocs.com`
is registered) sits **in front** as DNS + HTTPS edge + DDoS shield +
cache — it does not run the app itself.

```
visitor → Cloudflare (edge) → your VPS:443 (Caddy) → AllDocs (Node:3000)
                                                         └─ spawns Python adapters
```

Everything below assumes **Ubuntu 24.04 LTS** and that you're
comfortable on the command line. Budget: a 4GB-RAM box (~$4–6/mo).
Hetzner CX22, DigitalOcean basic 4GB, or Contabo VPS S all work — 4GB
matters because PyMuPDF holds a whole PDF in memory while processing.

---

## 1. Provision the VPS

Create an Ubuntu 24.04 server, add your SSH key, and log in:

```bash
ssh root@YOUR_SERVER_IP
```

Create an unprivileged user to run the app:

```bash
adduser --system --group --home /opt/alldocs alldocs
```

Note the server's public IP — you'll point Cloudflare at it in step 6.

---

## 2. System dependencies

```bash
# Node 22 (via NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# pnpm
npm install -g pnpm

# Python 3 + venv + build tools
apt-get install -y python3 python3-venv python3-dev build-essential

# Tesseract OCR + English data (add more language packs as needed,
# e.g. tesseract-ocr-deu tesseract-ocr-chi-sim tesseract-ocr-fra)
apt-get install -y tesseract-ocr

# Caddy (reverse proxy + TLS)
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy
```

---

## 3. Get the code onto the server

The repo is **private**, so use a GitHub deploy key or a personal
access token. Deploy-key route (recommended — read-only, scoped to
this one repo):

```bash
# As root, generate a key for the server:
ssh-keygen -t ed25519 -f /root/.ssh/alldocs_deploy -N ""
cat /root/.ssh/alldocs_deploy.pub
# → add this public key in GitHub: repo → Settings → Deploy keys →
#   Add deploy key (read access is enough).

# Tell git to use it:
cat >> /root/.ssh/config <<'EOF'
Host github-alldocs
    HostName github.com
    User git
    IdentityFile /root/.ssh/alldocs_deploy
    IdentitiesOnly yes
EOF

git clone github-alldocs:D-PRAIISE/AllDocs.git /opt/alldocs
```

---

## 4. Build the app + Python venv

```bash
cd /opt/alldocs

# Python venv with all three adapters' runtime deps
python3 -m venv venv
./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r deploy/requirements.txt

# Build the Next.js production bundle
cd web
pnpm install --frozen-lockfile
pnpm build
cd ..

# Hand ownership to the service user
chown -R alldocs:alldocs /opt/alldocs
```

> The Node app spawns `python -m pdf_adapter.cli …` etc. The systemd
> unit puts `/opt/alldocs/venv/bin` first on `PATH`, so those calls
> resolve to the venv interpreter that has pymupdf/openpyxl/etc.

---

## 5. Run it under systemd

```bash
# Edit the unit first — set a random ALLDOCS_IP_HASH_SALT:
sed -i "s/CHANGE_ME_TO_A_RANDOM_STRING/$(openssl rand -hex 16)/" \
    /opt/alldocs/deploy/alldocs.service

cp /opt/alldocs/deploy/alldocs.service /etc/systemd/system/alldocs.service
systemctl daemon-reload
systemctl enable --now alldocs

# Confirm it's up on localhost:3000
systemctl status alldocs
curl -s http://127.0.0.1:3000/api/health
```

You should see `{"status":"ok",...}`.

---

## 6. Point Cloudflare at the VPS

In the Cloudflare dashboard for **getalldocs.com**:

**a. DNS records** (DNS → Records):

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `getalldocs.com` (`@`) | `YOUR_SERVER_IP` | 🟠 Proxied |
| CNAME | `www` | `getalldocs.com` | 🟠 Proxied |

**b. SSL/TLS mode** (SSL/TLS → Overview): set to **Full (strict)**.

**c. Origin certificate** (SSL/TLS → Origin Server → Create
Certificate): accept the defaults (covers `getalldocs.com` +
`*.getalldocs.com`, 15-year validity). Copy the two blocks onto the
server:

```bash
# Paste the "Origin Certificate" block here:
nano /etc/caddy/cf-origin.pem
# Paste the "Private Key" block here:
nano /etc/caddy/cf-origin.key
chmod 600 /etc/caddy/cf-origin.key
```

---

## 7. Caddy reverse proxy

```bash
mkdir -p /var/log/caddy
cp /opt/alldocs/deploy/Caddyfile /etc/caddy/Caddyfile
systemctl reload caddy
systemctl status caddy
```

Now open **https://getalldocs.com** — you should land on the AllDocs
landing page, with the editor at **https://getalldocs.com/edit**.

---

## 8. Recommended Cloudflare hardening (free tier)

- **Caching**: Cloudflare auto-caches static assets. Make sure the
  API routes aren't cached — they already send `Cache-Control:
  no-store`, so this is handled, but you can add a Cache Rule to
  bypass cache on `/api/*` to be safe.
- **Bot Fight Mode** (Security → Bots): turn on. Free, blocks the
  obvious junk on top of AllDocs' own per-IP rate limiter.
- **Turnstile** (later): when traffic warrants, add Turnstile to the
  upload flow for bot defense beyond rate limiting. (Not built yet —
  a future task.)
- **Always Use HTTPS** (SSL/TLS → Edge Certificates): on.

---

## Updating to a new version

```bash
cd /opt/alldocs
sudo -u alldocs git pull
sudo -u alldocs ./venv/bin/pip install -r deploy/requirements.txt   # if deps changed
cd web && sudo -u alldocs pnpm install --frozen-lockfile && sudo -u alldocs pnpm build && cd ..
systemctl restart alldocs
```

---

## When you outgrow one box

The codebase is already shaped for it:
- Split the Python adapters onto worker boxes behind a queue (Redis).
- Move `uploads/` to object storage (Cloudflare R2 / S3) instead of
  local disk — swap the filesystem writes in the API routes.
- Run multiple Node instances behind Cloudflare load balancing.
- The rate-limiter's in-memory map becomes a Redis store (the
  interface in `web/lib/rate-limit.ts` is shaped for this swap).

Nothing in the current build blocks horizontal scale; it's a
single-box deploy now purely for simplicity + cost.
