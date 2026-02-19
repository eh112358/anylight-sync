# AnyList ↔ Skylight Sync Service

A self-hosted service that keeps your AnyList shopping lists and meal plan calendar in sync with your Skylight display frame.

## What it does

- **Shopping lists:** Any item you add, check off, or remove in AnyList appears on your Skylight within seconds. Changes made on the Skylight side sync back to AnyList on the next poll cycle (every 60 seconds by default).
- **Meal planning:** Meals you schedule in AnyList appear on your Skylight calendar. The service syncs a 30-day rolling window (30 days before and after today).
- **Crash recovery:** If the service restarts, it reconciles both platforms on startup using AnyList as the source of truth.

## Requirements

- A Skylight frame (shopping list sync works on all plans; meal plan sync requires **Skylight Plus**)
- An AnyList account
- Docker (for local testing) or a Kubernetes cluster (for deployment)
- Your Skylight **Frame ID** (see below)

## Finding Your Skylight Frame ID

The Frame ID is a unique identifier for your household's Skylight. You need it once during setup.

1. Install [Proxyman](https://proxyman.io/) (Mac) or [mitmproxy](https://mitmproxy.org/) on your computer
2. Configure your phone to route traffic through it
3. Open the Skylight app and tap around (view your lists, calendar, etc.)
4. Look for requests to `app.ourskylight.com/api/frames/XXXXXXXX/...`
5. Copy that `XXXXXXXX` value — that's your Frame ID

## Setup

### 1. Copy the example environment file

```bash
cp .env.example .env
```

Then edit `.env` and fill in your credentials:

```env
ANYLIST_EMAIL=your@email.com
ANYLIST_PASSWORD=yourpassword
SKYLIGHT_EMAIL=your@email.com
SKYLIGHT_PASSWORD=yourpassword
SKYLIGHT_FRAME_ID=your-frame-id-here

# Which lists to sync — format: "AnyList Name=Skylight Name"
LIST_SYNC_PAIRS=Grocery List=Grocery List
```

### 2. Install dependencies

```bash
npm install
```

### 3. Run locally (development)

```bash
npm run dev
```

This starts the service with hot reload. Logs appear in your terminal.

### 4. Build and run with Docker

```bash
# Build the image
docker build -t anylist-skylight-sync .

# Run it
docker compose up
```

## Deploying to Kubernetes

### Step 1: Build and push the image

Build the Docker image and push it to wherever your Kubernetes cluster pulls images from (e.g., a local registry on your Synology NAS, or Docker Hub).

### Step 2: Create the credentials secret

Run this once on your cluster — replace the placeholder values with your real credentials:

```bash
kubectl create secret generic anylist-skylight-sync-secrets \
  --from-literal=ANYLIST_EMAIL='your@email.com' \
  --from-literal=ANYLIST_PASSWORD='yourpassword' \
  --from-literal=SKYLIGHT_EMAIL='your@email.com' \
  --from-literal=SKYLIGHT_PASSWORD='yourpassword' \
  --from-literal=SKYLIGHT_FRAME_ID='your-frame-id'
```

### Step 3: Edit the deployment

Open `k8s/deployment.yaml` and update:
- `LIST_SYNC_PAIRS` — the list names you want to sync
- `TIMEZONE` — your local timezone (e.g. `America/Chicago`)
- `image:` — point to your actual image location

### Step 4: Apply

```bash
kubectl apply -f k8s/deployment.yaml
```

### Check it's running

```bash
kubectl get pods
kubectl logs deployment/anylist-skylight-sync
```

## Syncing multiple lists

To sync more than one list, update `LIST_SYNC_PAIRS` in `.env` or `k8s/deployment.yaml`:

```
LIST_SYNC_PAIRS=Grocery List=Grocery List,Hardware Store=Hardware
```

Each pair is `AnyList list name=Skylight list name`. The names on each side don't have to match.

## How it works

```
AnyList (real-time WebSocket)
    │
    ▼  (change detected within ~2 seconds)
Sync service diffs against SQLite state
    │
    ▼
Skylight updated via API


Skylight (polled every 60 seconds)
    │
    ▼  (change detected within ~60 seconds)
Sync service diffs against SQLite state
    │
    ▼
AnyList updated via API
```

**If both sides changed the same item** (e.g., you edited something in AnyList while offline and also on Skylight), AnyList wins.

## Configuration reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANYLIST_EMAIL` | Yes | — | Your AnyList login email |
| `ANYLIST_PASSWORD` | Yes | — | Your AnyList password |
| `SKYLIGHT_EMAIL` | Yes | — | Your Skylight login email |
| `SKYLIGHT_PASSWORD` | Yes | — | Your Skylight password |
| `SKYLIGHT_FRAME_ID` | Yes | — | Your household Frame ID (see setup above) |
| `LIST_SYNC_PAIRS` | Yes | — | Comma-separated list pairs (see above) |
| `SYNC_INTERVAL_MS` | No | `60000` | How often to poll Skylight (minimum 10000ms) |
| `TIMEZONE` | No | `America/New_York` | Your local timezone |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, or `error` |
| `STATE_DB_PATH` | No | `/data/sync-state.db` | Where the SQLite state file lives |

## Known limitations

- **Skylight has no quantity field.** If you add "2 lbs Ground Beef" in AnyList, it appears as "2 lbs Ground Beef" as a single label in Skylight (quantity is prepended to the name).
- **Meal sync requires Skylight Plus.** If you don't have Plus, meal sync will log a warning and skip silently — list sync still works.
- **Both APIs are unofficial.** Either platform could change their backend without notice and break the sync. Check the logs if something stops working.
- **Only one service instance should run at a time.** Running two copies simultaneously will cause duplicate items and sync conflicts.
