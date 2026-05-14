# Deploy the platform-server

The platform-server is the custody service the wallet talks to when a user signs up with email and password. Until it has a public URL, only people running the wallet on the same machine as the dev backend can use the platform track.

You have three options. Pick whichever feels lowest-friction, all three work, all three are cheap.

## Option A: Fly.io (recommended for v0)

**Why pick this:** free tier, zero servers to manage, auto-TLS, single command to redeploy. The first hit after idle has a one-second cold start which is fine for a beta.

**Setup, one time:**

1. Install flyctl:
   - Windows (PowerShell): `iwr https://fly.io/install.ps1 -useb | iex`
   - Mac / Linux: `curl -L https://fly.io/install.sh | sh`
2. Sign up:
   ```
   flyctl auth signup
   ```
   No credit card needed for the smallest VM, but they ask for one to deter abuse.
3. From `platform-server/`:
   ```
   flyctl launch --no-deploy
   ```
   When it asks "Would you like to copy its configuration to the new app?" say **yes**. Otherwise it overwrites the existing `fly.toml`.
4. Create the persistent SQLite volume:
   ```
   flyctl volumes create ae_platform_data --region iad --size 1
   ```
5. Generate the cryptographic secrets and set them on the app. **Run these on your machine, not on Fly:**
   ```
   flyctl secrets set \
     AE_PLATFORM_RECOVERY_PRIVATE_KEY=$(openssl rand -hex 32) \
     AE_PLATFORM_SESSION_SECRET=$(openssl rand -hex 32)
   ```
   On Windows PowerShell, use `[guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')` or run from WSL.
6. Deploy:
   ```
   flyctl deploy
   ```
7. Note the public hostname: `flyctl status` shows it (something like `ae-platform-server.fly.dev`).

**Verify:**
```
curl https://ae-platform-server.fly.dev/api/v1/health
```
Should return `{"status":"ok","timestamp":...}`.

**Point the wallet at production:** when packaging the installer, set the env var so Vite bakes the URL into the bundle:
```
cd ae-app
VITE_PLATFORM_URL=https://ae-platform-server.fly.dev/api/v1 npm run electron:build:win
```

**Redeploys** are `flyctl deploy` from `platform-server/`. Or set up the GitHub Actions workflow (see Option D below) to redeploy on push.

## Option B: Render.com (alternative)

**Why pick this:** even simpler than Fly. Connect the GitHub repo, click Apply, set two env vars in the dashboard, done. Tradeoff: free tier sleeps after 15 min idle, cold start is ~30 seconds.

**Setup, one time:**

1. Sign up at https://render.com (GitHub login).
2. **New > Blueprint > Connect this repo**. Render reads `platform-server/render.yaml` and creates the service.
3. In the service dashboard, **Environment** tab, set:
   - `AE_PLATFORM_RECOVERY_PRIVATE_KEY` (generate: `openssl rand -hex 32`)
   - `AE_PLATFORM_SESSION_SECRET` (same)
4. Save. Render redeploys.
5. Note the `*.onrender.com` URL.
6. Build the wallet with `VITE_PLATFORM_URL=https://<your-app>.onrender.com/api/v1`.

## Option C: Hetzner / DigitalOcean + Caddy (maximum control)

**Why pick this:** about $5/mo, no cold starts, you control the host, you can colocate the AE bootstrap node on the same box later.

**Setup, one time:**

1. Provision a VPS:
   - Hetzner CX22 (~€4.50/mo, 2 vCPU, 4GB) is fine
   - DigitalOcean $6 droplet is fine
   - Ubuntu 24.04 or Debian 12
2. SSH in. Install Docker:
   ```
   apt update && apt install -y docker.io docker-compose-plugin
   ```
3. Point your DNS A record at the server IP (e.g. `platform.alignmenteconomy.org` -> the IP). DNS propagation can take a few minutes.
4. Clone the repo on the server:
   ```
   cd /opt
   git clone https://github.com/mattfmccormick/alignment-economy-code.git
   cd alignment-economy-code/platform-server
   ```
5. Create the env file:
   ```
   cp .env.example .env
   nano .env   # fill in secrets and AE_PLATFORM_DOMAIN
   ```
   The two `openssl rand -hex 32` values, plus your domain.
6. Bring it up:
   ```
   docker compose up -d --build
   ```
   Caddy auto-fetches a Let's Encrypt cert the first time the domain receives a request.

**Verify:**
```
curl https://platform.alignmenteconomy.org/api/v1/health
```

**Redeploy** after a `git pull`:
```
cd /opt/alignment-economy-code/platform-server
git pull
docker compose up -d --build
```

## Option D: CI-driven deploy (any option above)

The `.github/workflows/platform-server.yml` workflow already runs tests on every push to `platform-server/` and pushes a Docker image to GHCR (`ghcr.io/mattfmccormick/ae-platform-server`) on push to main.

To wire it into auto-deploy:

- **Fly.io:** add a `deploy` step at the end of the workflow using `flyctl deploy --remote-only`. Requires `FLY_API_TOKEN` set as a GitHub Actions secret (get one with `flyctl auth token`).
- **Render:** connects to GitHub directly. Each push to main triggers a redeploy automatically; no GHA changes needed.
- **VPS:** add an `ssh` step that runs `docker compose pull && docker compose up -d` on the server. Requires SSH key + host added as GHA secrets.

Wire whichever flavor you pick when the manual cadence starts to chafe.

## What you need to remember

1. Keep `AE_PLATFORM_RECOVERY_PRIVATE_KEY` safe. If it leaks, every recovery blob ever stored on the server becomes decryptable by whoever has the key.
2. Back up the SQLite volume. On Fly: `flyctl ssh sftp get /data/platform.db`. On Render: snapshot via dashboard. On Hetzner: `docker compose cp platform-server:/data/platform.db ./backup.db`. Once a day to start.
3. The platform-server stores no plaintext anything that costs an attacker more than the encryption layer to retrieve. The vault blobs are encrypted with the user's password (server can't open them). The recovery blobs need the recovery key. Worst case under server compromise: an attacker with the recovery key AND a copy of the DB can read every account. KMS / HSM-backed key storage moves this further out of reach; for v0, env-var-in-secret-manager is the working balance.
