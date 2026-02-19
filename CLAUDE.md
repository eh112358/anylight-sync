# AnyList ↔ Skylight Sync Server

> **Claude Code context file.** Place this at the root of the project repo as `CLAUDE.md`.
> Claude Code reads this automatically as project-level instructions.

---

## Project Goal

A self-hosted Node.js/TypeScript service that runs on the home network (Kubernetes on Synology NAS) and keeps two platforms in sync:

- **AnyList** shopping lists ↔ **Skylight** grocery lists
- **AnyList** meal planning calendar ↔ **Skylight** meal sittings + recipe box

---

## Tech Stack

- **Runtime:** Node.js (LTS)
- **Language:** TypeScript (strict mode)
- **Package manager:** npm
- **Containerization:** Docker → deployed to Kubernetes on Synology NAS
- **AnyList client:** [`anylist`](https://github.com/codetheweb/anylist) npm package (unofficial, reverse-engineered)
- **Skylight client:** Custom HTTP client built from reverse-engineered API (see below — no official SDK for the calendar product)
- **State/diffing:** SQLite via `better-sqlite3` (lightweight, no external DB needed)

---

## Project Structure (target)

```
anylist-skylight-sync/
├── CLAUDE.md                  # This file
├── Dockerfile
├── docker-compose.yml
├── k8s/
│   └── deployment.yaml
├── src/
│   ├── index.ts               # Entry point, starts sync loops
│   ├── config.ts              # Env var loading + validation
│   ├── anylist/
│   │   ├── client.ts          # Wrapper around 'anylist' npm package
│   │   └── types.ts           # Normalized types
│   ├── skylight/
│   │   ├── auth.ts            # Login + token caching
│   │   ├── client.ts          # HTTP client (fetch-based)
│   │   ├── endpoints/
│   │   │   ├── lists.ts       # Shopping list CRUD
│   │   │   └── meals.ts       # Recipes + meal sittings CRUD
│   │   └── types.ts           # Skylight API response types
│   ├── sync/
│   │   ├── lists.ts           # Shopping list sync logic
│   │   ├── meals.ts           # Meal plan sync logic
│   │   └── state.ts           # SQLite state store for diffing
│   └── utils/
│       ├── logger.ts
│       └── retry.ts
├── package.json
└── tsconfig.json
```

---

## Environment Variables

```env
# AnyList credentials
ANYLIST_EMAIL=your@email.com
ANYLIST_PASSWORD=yourpassword

# Skylight credentials
SKYLIGHT_EMAIL=your@email.com
SKYLIGHT_PASSWORD=yourpassword
SKYLIGHT_FRAME_ID=abc123          # Household identifier — see "Finding Your Frame ID" below

# Sync config
SYNC_INTERVAL_MS=60000            # How often to poll Skylight (default: 60s)
ANYLIST_LIST_NAME=Grocery List    # Name of the AnyList list to sync
SKYLIGHT_LIST_NAME=Grocery List   # Name of the Skylight list to sync
TIMEZONE=America/New_York

# Optional
LOG_LEVEL=info                    # debug | info | warn | error
STATE_DB_PATH=/data/sync-state.db # SQLite file path (mount as volume in k8s)
```

---

## AnyList API

**Package:** `npm install anylist`
**Source:** https://github.com/codetheweb/anylist
**Auth:** Email + password (stored as env vars)

### Key Capabilities

```typescript
import AnyList from 'anylist';

const any = new AnyList({ email, password });
await any.login();
await any.getLists();

// Real-time updates via WebSocket (no polling needed on AnyList side)
any.on('lists-update', (lists) => {
  // fires whenever any list changes
});

// List operations
const list = any.getListByName('Grocery List');
const item = any.createItem({ name: 'Milk', quantity: '1 gallon' });
await list.addItem(item);
item.checked = true;
await item.save();
await list.removeItem(item);

// Meal planning
await any.getMealPlanningCalendarEvents();
const event = any.createEvent({ title: 'Spaghetti Bolognese' });
await event.save();

// Always call teardown before exit
any.teardown();
```

### AnyList Item Fields (relevant ones)

```typescript
{
  id: string;
  name: string;           // item label
  quantity: string;       // e.g., "2 lbs", "1 gallon"
  checked: boolean;       // completion status
  categoryMatchId?: string; // AnyList's auto-categorization
  note?: string;
}
```

### AnyList Meal Planning Event Fields

```typescript
{
  id: string;
  title: string;          // recipe/meal name
  date: Date;
  // NOTE: AnyList meal events are sparse — mostly just title + date
}
```

---

## Skylight API

**Status:** Unofficial / reverse-engineered from `@eaglebyte/skylight-mcp` package source
**Base URL:** `https://app.ourskylight.com`
**⚠️ Warning:** No official API. May break if Skylight updates their backend without notice.

### Authentication (2-step)

**Step 1 — Login:**
```
POST https://app.ourskylight.com/api/sessions
Content-Type: application/json

{ "email": "...", "password": "..." }
```

**Response:**
```json
{
  "data": {
    "id": "userId",
    "attributes": {
      "email": "...",
      "token": "abc123token",
      "subscription_status": "plus"
    }
  }
}
```

**Step 2 — All subsequent requests:**
```
Authorization: Basic base64(userId + ":" + token)
Accept: application/json
```

Token is stable — cache it and re-login only on 401.

### Finding Your Frame ID

The `frameId` is your household identifier. One-time setup:

1. Install [Proxyman](https://proxyman.io/) or [mitmproxy](https://mitmproxy.org/) on your Mac/PC
2. Configure your phone to route traffic through it
3. Open the Skylight app and navigate around
4. Look for requests to `app.ourskylight.com/api/frames/{frameId}/...`
5. Copy that `frameId` value — it won't change

Alternatively, once you have a valid auth token, call:
```
GET /api/frames/{frameId}/devices
```
...but you need the frameId to call this. Use the proxy approach first.

### Response Format (JSON:API)

All responses follow the [JSON:API](https://jsonapi.org/) spec:
```json
{
  "data": [...],          // primary resource(s)
  "included": [...],      // side-loaded related resources
  "meta": { ... }
}
```

---

## Skylight API Endpoints

All endpoints are relative to `https://app.ourskylight.com` and require `{frameId}` substitution.

### Shopping Lists

| Operation | Method | Path |
|---|---|---|
| Get all lists | GET | `/api/frames/{frameId}/lists` |
| Get list + items | GET | `/api/frames/{frameId}/lists/{listId}` |
| Create list | POST | `/api/frames/{frameId}/lists` |
| Update list | PUT | `/api/frames/{frameId}/lists/{listId}` |
| Delete list | DELETE | `/api/frames/{frameId}/lists/{listId}` |
| Add item | POST | `/api/frames/{frameId}/lists/{listId}/list_items` |
| Update item | PUT | `/api/frames/{frameId}/lists/{listId}/list_items/{itemId}` |
| Delete item | DELETE | `/api/frames/{frameId}/lists/{listId}/list_items/{itemId}` |

**List kinds:** `"shopping"` or `"to_do"`

**Create/Update list body (JSON:API):**
```json
{
  "data": {
    "type": "list",
    "attributes": {
      "label": "Grocery List",
      "kind": "shopping",
      "color": null
    }
  }
}
```

**Create item body:**
```json
{
  "data": {
    "type": "list_item",
    "attributes": {
      "label": "Milk",
      "section": "Dairy"
    }
  }
}
```

**Item `status` values:** `"pending"` | `"completed"`

**List response includes:**
- `attributes.label` — list name
- `attributes.kind` — `"shopping"` or `"to_do"`
- `attributes.default_grocery_list` — boolean, marks the primary grocery list
- `relationships.list_items.data` — array of item ID references (not full items)

**Item fields:**
- `attributes.label` — item name
- `attributes.status` — `"pending"` | `"completed"`
- `attributes.section` — category string (e.g., `"Dairy"`, `"Produce"`) or null

---

### Meal Planning (requires Skylight Plus subscription)

| Operation | Method | Path |
|---|---|---|
| Get categories | GET | `/api/frames/{frameId}/meals/categories` |
| Get all recipes | GET | `/api/frames/{frameId}/meals/recipes?include=meal_category` |
| Get single recipe | GET | `/api/frames/{frameId}/meals/recipes/{recipeId}` |
| Create recipe | POST | `/api/frames/{frameId}/meals/recipes` |
| Update recipe | PATCH | `/api/frames/{frameId}/meals/recipes/{recipeId}` |
| Delete recipe | DELETE | `/api/frames/{frameId}/meals/recipes/{recipeId}` |
| Push recipe → grocery list | POST | `/api/frames/{frameId}/meals/recipes/{recipeId}/add_to_grocery_list` |
| Get scheduled meals | GET | `/api/frames/{frameId}/meals/sittings?date_min=YYYY-MM-DD&date_max=YYYY-MM-DD` |
| Schedule a meal | POST | `/api/frames/{frameId}/meals/sittings` |

**Create recipe body:**
```json
{
  "summary": "Spaghetti Bolognese",
  "description": "Full recipe text / ingredient list here",
  "meal_category_id": "dinner-category-id"
}
```

**Recipe fields:**
- `attributes.summary` — recipe name
- `attributes.description` — full text (ingredients + instructions)
- `attributes.meal_category_id` — links to Breakfast/Lunch/Dinner/Snack category

**Meal categories** (fetch from `/meals/categories`):
- Breakfast, Lunch, Dinner, Snack (user-customizable)
- Each has an `id` and `attributes.name`

**Create meal sitting (schedule a meal):**
```json
{
  "date": "2025-03-15",
  "meal_category_id": "dinner-category-id",
  "meal_recipe_id": "optional-recipe-id"
}
```

**Meal sitting fields:**
- `attributes.date` — `YYYY-MM-DD`
- `attributes.meal_time` — category name (e.g., `"Dinner"`)

**`date_max` is exclusive** — to include events on a specific end date, add 1 day to it.

---

### Calendar Events (bonus — not primary sync target)

| Operation | Method | Path |
|---|---|---|
| Get events | GET | `/api/frames/{frameId}/calendar_events?date_min=YYYY-MM-DD&date_max=YYYY-MM-DD&timezone=America/New_York` |
| Create event | POST | `/api/frames/{frameId}/calendar_events` |
| Update event | PUT | `/api/frames/{frameId}/calendar_events/{eventId}` |
| Delete event | DELETE | `/api/frames/{frameId}/calendar_events/{eventId}` |
| Get source calendars | GET | `/api/frames/{frameId}/source_calendars` |

---

## Sync Architecture

### Problem: Asymmetric Update Models

| Platform | Update model |
|---|---|
| AnyList | WebSocket push (real-time) |
| Skylight | Poll-only (no webhooks) |

### Solution: Hybrid Approach

```
┌─────────────────────────────────────────────────────┐
│                   Sync Service                       │
│                                                      │
│  AnyList WebSocket ──► onChange handler             │
│                              │                       │
│                              ▼                       │
│                      Diff against                    │
│                      SQLite state                    │
│                              │                       │
│                              ▼                       │
│                      Push to Skylight               │
│                                                      │
│  Skylight poll (60s) ──► fetch state                │
│                              │                       │
│                              ▼                       │
│                      Diff against                    │
│                      SQLite state                    │
│                              │                       │
│                              ▼                       │
│                      Push to AnyList                │
└─────────────────────────────────────────────────────┘
```

### Conflict Resolution Strategy

**Source of truth:** Last-write-wins, with a 5-second debounce to avoid echo loops.

When a change is applied FROM platform A TO platform B, record the resulting state in SQLite with a `syncedAt` timestamp. If a Skylight poll detects a "change" within 10 seconds of a write we just made, treat it as an echo and skip it.

### State Store (SQLite schema)

```sql
-- Tracks the synced state of each item pairing
CREATE TABLE list_item_map (
  id INTEGER PRIMARY KEY,
  anylist_item_id TEXT NOT NULL,
  skylight_item_id TEXT NOT NULL,
  anylist_list_id TEXT NOT NULL,
  skylight_list_id TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL,  -- 'pending' | 'completed'
  synced_at INTEGER NOT NULL,  -- Unix ms
  last_write_source TEXT  -- 'anylist' | 'skylight'
);

-- Tracks recipe pairings
CREATE TABLE recipe_map (
  id INTEGER PRIMARY KEY,
  anylist_event_id TEXT,
  skylight_recipe_id TEXT,
  title TEXT NOT NULL,
  synced_at INTEGER NOT NULL
);

-- Tracks scheduled meal pairings
CREATE TABLE meal_sitting_map (
  id INTEGER PRIMARY KEY,
  anylist_event_id TEXT,
  skylight_sitting_id TEXT,
  date TEXT NOT NULL,  -- YYYY-MM-DD
  meal_time TEXT,
  synced_at INTEGER NOT NULL
);
```

---

## Sync Logic: Shopping Lists

### AnyList → Skylight (real-time via WebSocket event)

1. On `lists-update`, fetch the target list from AnyList by name
2. Diff current items against `list_item_map` SQLite state
3. For each **new** item: `POST /api/frames/{frameId}/lists/{skylightListId}/list_items`
4. For each **deleted** item: `DELETE /api/frames/{frameId}/lists/{skylightListId}/list_items/{skylightItemId}`
5. For each **updated** item (label or status changed): `PUT .../list_items/{itemId}`
6. Update SQLite state

### Skylight → AnyList (polled every `SYNC_INTERVAL_MS`)

1. `GET /api/frames/{frameId}/lists/{skylightListId}` with items included
2. Diff against SQLite state
3. For each new/deleted/updated item, apply the inverse operation on AnyList
4. Update SQLite state

### Item Mapping Notes

| AnyList field | Skylight field |
|---|---|
| `item.name` | `attributes.label` |
| `item.checked === true` | `attributes.status === "completed"` |
| `item.checked === false` | `attributes.status === "pending"` |
| `item.quantity` | Prepend to label: `"2 lbs Ground Beef"` (Skylight has no quantity field) |
| _(no equivalent)_ | `attributes.section` (grocery category) |

---

## Sync Logic: Meal Planning

### AnyList meal events → Skylight sittings

AnyList `MealPlanningCalendarEvent` maps to a Skylight meal sitting:
- `event.title` → find or create matching recipe in Skylight recipe box → link to sitting
- `event.date` → `sitting.date`

### Skylight recipes

Skylight has a persistent "Recipe Box" (`/meals/recipes`). The workflow:
1. When AnyList adds a meal event, check if a recipe with that title exists in Skylight
2. If not, create it: `POST /meals/recipes` with `summary = event.title`
3. Then create the meal sitting linking that recipe to the date

---

## Skylight Client Implementation Notes

### TypeScript client skeleton

```typescript
// src/skylight/client.ts

const BASE_URL = 'https://app.ourskylight.com';

export class SkylightClient {
  private token: string | null = null;
  private userId: string | null = null;

  constructor(
    private email: string,
    private password: string,
    private frameId: string
  ) {}

  async login(): Promise<void> {
    const res = await fetch(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: this.email, password: this.password }),
    });
    if (!res.ok) throw new Error(`Skylight login failed: ${res.status}`);
    const data = await res.json();
    this.userId = data.data.id;
    this.token = data.data.attributes.token;
  }

  private getAuthHeader(): string {
    const encoded = Buffer.from(`${this.userId}:${this.token}`).toString('base64');
    return `Basic ${encoded}`;
  }

  async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    if (!this.token) await this.login();
    const url = `${BASE_URL}${path.replace('{frameId}', this.frameId)}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: this.getAuthHeader(),
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(options.headers ?? {}),
      },
    });
    if (res.status === 401) {
      // re-login once and retry
      this.token = null;
      await this.login();
      return this.request<T>(path, options);
    }
    if (!res.ok) throw new Error(`Skylight API error: ${res.status} ${url}`);
    return res.json() as Promise<T>;
  }

  get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = params
      ? `${path}?${new URLSearchParams(params)}`
      : path;
    return this.request<T>(url, { method: 'GET' });
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: 'POST', body: JSON.stringify(body) });
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
  }

  delete(path: string): Promise<void> {
    return this.request<void>(path, { method: 'DELETE' });
  }
}
```

---

## Docker / Kubernetes

### Dockerfile

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist/ ./dist/
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
```

### k8s Deployment sketch

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: anylist-skylight-sync
spec:
  replicas: 1
  template:
    spec:
      containers:
      - name: sync
        image: anylist-skylight-sync:latest
        envFrom:
        - secretRef:
            name: sync-secrets
        volumeMounts:
        - name: data
          mountPath: /data
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: sync-data-pvc
```

SQLite DB file should live on a PVC mounted at `/data` so state survives pod restarts.

---

## Known Limitations & Risks

1. **Both APIs are unofficial** — either could break without warning if the companies update their backends
2. **Skylight meal features require Plus subscription** — grocery list sync works without it
3. **AnyList has no public API TOS** — use responsibly, avoid hammering with requests
4. **Skylight rate limiting** — unknown limits; use polite intervals (60s+) and back off on 429s
5. **Item quantity:** Skylight has no quantity field — encode it in the label (e.g., `"2 lbs Ground Beef"`) or drop it
6. **AnyList categories vs Skylight sections:** AnyList auto-categorizes items; Skylight uses freeform section strings. Mapping is approximate
7. **Skylight `date_max` is exclusive** — always add 1 day when querying a range

---

## Development Workflow

```bash
# Install deps
npm install

# Dev mode with hot reload
npm run dev

# Build
npm run build

# Type check
npm run typecheck

# Run tests
npm test

# Build Docker image
docker build -t anylist-skylight-sync .
```

---

## References

- AnyList npm package: https://github.com/codetheweb/anylist
- AnyList API docs: https://codetheweb.github.io/anylist/
- Skylight MCP source (inspected): https://github.com/TheEagleByte/skylight-mcp
- Skylight base URL: `https://app.ourskylight.com`
- JSON:API spec: https://jsonapi.org/
