// SQLite state store — the source of truth for what we last synced.
//
// Why this exists:
//   Neither AnyList nor Skylight can tell us "what changed since last time."
//   So we keep our own snapshot of the last synced state. On each sync cycle,
//   we compare the live state from each platform against this snapshot to figure
//   out what's new, changed, or deleted.
//
// On crash recovery:
//   We load the last known state from this database and use it as the baseline
//   for reconciliation on startup.
//
// Conflict resolution:
//   AnyList is the source of truth. If both sides changed the same item, the
//   AnyList version wins.

import Database from 'better-sqlite3';
import { logger } from '../utils/logger.js';

// How long after we write a change to Skylight before we stop treating
// Skylight's "new" state as an echo of what we just wrote.
// This prevents the sync loop from bouncing a change back and forth.
const ECHO_WINDOW_MS = 10_000;

export interface ListItemRecord {
  id: number;
  anylistItemId: string;
  skylightItemId: string;
  anylistListId: string;
  skylightListId: string;
  label: string;           // the item label as last synced
  status: 'pending' | 'completed';
  syncedAt: number;        // Unix timestamp in ms
  lastWriteSource: 'anylist' | 'skylight';
}

export interface RecipeRecord {
  id: number;
  anylistEventId: string;
  skylightRecipeId: string;
  title: string;
  syncedAt: number;
}

export interface MealSittingRecord {
  id: number;
  anylistEventId: string;
  skylightSittingId: string;
  date: string;            // YYYY-MM-DD
  mealTime: string | null;
  syncedAt: number;
}

export class StateStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    logger.info('Opening state database', { dbPath });
    this.db = new Database(dbPath);
    // WAL mode gives better performance and allows reads while a write is happening
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  // Creates the tables if they don't exist yet.
  // Safe to call on every startup — it won't destroy existing data.
  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS list_item_map (
        id                 INTEGER PRIMARY KEY,
        anylist_item_id    TEXT NOT NULL,
        skylight_item_id   TEXT NOT NULL,
        anylist_list_id    TEXT NOT NULL,
        skylight_list_id   TEXT NOT NULL,
        label              TEXT NOT NULL,
        status             TEXT NOT NULL CHECK(status IN ('pending', 'completed')),
        synced_at          INTEGER NOT NULL,
        last_write_source  TEXT NOT NULL CHECK(last_write_source IN ('anylist', 'skylight'))
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_list_item_anylist
        ON list_item_map (anylist_item_id);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_list_item_skylight
        ON list_item_map (skylight_item_id);

      CREATE TABLE IF NOT EXISTS recipe_map (
        id                  INTEGER PRIMARY KEY,
        anylist_event_id    TEXT NOT NULL,
        skylight_recipe_id  TEXT NOT NULL,
        title               TEXT NOT NULL,
        synced_at           INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_recipe_anylist
        ON recipe_map (anylist_event_id);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_recipe_skylight
        ON recipe_map (skylight_recipe_id);

      CREATE TABLE IF NOT EXISTS meal_sitting_map (
        id                   INTEGER PRIMARY KEY,
        anylist_event_id     TEXT NOT NULL,
        skylight_sitting_id  TEXT NOT NULL,
        date                 TEXT NOT NULL,
        meal_time            TEXT,
        synced_at            INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_sitting_anylist
        ON meal_sitting_map (anylist_event_id);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_sitting_skylight
        ON meal_sitting_map (skylight_sitting_id);
    `);

    logger.debug('State database schema initialized');
  }

  // --- List item map ---

  getAllListItems(): ListItemRecord[] {
    return this.db.prepare(`
      SELECT
        id,
        anylist_item_id    AS anylistItemId,
        skylight_item_id   AS skylightItemId,
        anylist_list_id    AS anylistListId,
        skylight_list_id   AS skylightListId,
        label,
        status,
        synced_at          AS syncedAt,
        last_write_source  AS lastWriteSource
      FROM list_item_map
    `).all() as ListItemRecord[];
  }

  getListItemByAnylistId(anylistItemId: string): ListItemRecord | null {
    return this.db.prepare(`
      SELECT
        id,
        anylist_item_id    AS anylistItemId,
        skylight_item_id   AS skylightItemId,
        anylist_list_id    AS anylistListId,
        skylight_list_id   AS skylightListId,
        label,
        status,
        synced_at          AS syncedAt,
        last_write_source  AS lastWriteSource
      FROM list_item_map
      WHERE anylist_item_id = ?
    `).get(anylistItemId) as ListItemRecord | null;
  }

  getListItemBySkylightId(skylightItemId: string): ListItemRecord | null {
    return this.db.prepare(`
      SELECT
        id,
        anylist_item_id    AS anylistItemId,
        skylight_item_id   AS skylightItemId,
        anylist_list_id    AS anylistListId,
        skylight_list_id   AS skylightListId,
        label,
        status,
        synced_at          AS syncedAt,
        last_write_source  AS lastWriteSource
      FROM list_item_map
      WHERE skylight_item_id = ?
    `).get(skylightItemId) as ListItemRecord | null;
  }

  upsertListItem(record: Omit<ListItemRecord, 'id'>): void {
    this.db.prepare(`
      INSERT INTO list_item_map
        (anylist_item_id, skylight_item_id, anylist_list_id, skylight_list_id,
         label, status, synced_at, last_write_source)
      VALUES
        (@anylistItemId, @skylightItemId, @anylistListId, @skylightListId,
         @label, @status, @syncedAt, @lastWriteSource)
      ON CONFLICT(anylist_item_id) DO UPDATE SET
        skylight_item_id  = excluded.skylight_item_id,
        label             = excluded.label,
        status            = excluded.status,
        synced_at         = excluded.synced_at,
        last_write_source = excluded.last_write_source
    `).run(record);
  }

  deleteListItemByAnylistId(anylistItemId: string): void {
    this.db.prepare('DELETE FROM list_item_map WHERE anylist_item_id = ?').run(anylistItemId);
  }

  deleteListItemBySkylightId(skylightItemId: string): void {
    this.db.prepare('DELETE FROM list_item_map WHERE skylight_item_id = ?').run(skylightItemId);
  }

  // Returns true if a change we wrote to Skylight was recent enough to be
  // considered an echo (i.e., Skylight is just reflecting what we just sent).
  isEchoFromRecentWrite(skylightItemId: string): boolean {
    const record = this.getListItemBySkylightId(skylightItemId);
    if (!record) return false;
    if (record.lastWriteSource !== 'anylist') return false;
    const ageMs = Date.now() - record.syncedAt;
    return ageMs < ECHO_WINDOW_MS;
  }

  // --- Recipe map ---

  getAllRecipes(): RecipeRecord[] {
    return this.db.prepare(`
      SELECT
        id,
        anylist_event_id   AS anylistEventId,
        skylight_recipe_id AS skylightRecipeId,
        title,
        synced_at          AS syncedAt
      FROM recipe_map
    `).all() as RecipeRecord[];
  }

  getRecipeByTitle(title: string): RecipeRecord | null {
    return this.db.prepare(`
      SELECT
        id,
        anylist_event_id   AS anylistEventId,
        skylight_recipe_id AS skylightRecipeId,
        title,
        synced_at          AS syncedAt
      FROM recipe_map
      WHERE title = ?
    `).get(title) as RecipeRecord | null;
  }

  getRecipeByAnylistId(anylistEventId: string): RecipeRecord | null {
    return this.db.prepare(`
      SELECT
        id,
        anylist_event_id   AS anylistEventId,
        skylight_recipe_id AS skylightRecipeId,
        title,
        synced_at          AS syncedAt
      FROM recipe_map
      WHERE anylist_event_id = ?
    `).get(anylistEventId) as RecipeRecord | null;
  }

  upsertRecipe(record: Omit<RecipeRecord, 'id'>): void {
    this.db.prepare(`
      INSERT INTO recipe_map
        (anylist_event_id, skylight_recipe_id, title, synced_at)
      VALUES
        (@anylistEventId, @skylightRecipeId, @title, @syncedAt)
      ON CONFLICT(anylist_event_id) DO UPDATE SET
        skylight_recipe_id = excluded.skylight_recipe_id,
        title              = excluded.title,
        synced_at          = excluded.synced_at
    `).run(record);
  }

  deleteRecipeByAnylistId(anylistEventId: string): void {
    this.db.prepare('DELETE FROM recipe_map WHERE anylist_event_id = ?').run(anylistEventId);
  }

  // --- Meal sitting map ---

  getAllMealSittings(): MealSittingRecord[] {
    return this.db.prepare(`
      SELECT
        id,
        anylist_event_id    AS anylistEventId,
        skylight_sitting_id AS skylightSittingId,
        date,
        meal_time           AS mealTime,
        synced_at           AS syncedAt
      FROM meal_sitting_map
    `).all() as MealSittingRecord[];
  }

  getMealSittingByAnylistId(anylistEventId: string): MealSittingRecord | null {
    return this.db.prepare(`
      SELECT
        id,
        anylist_event_id    AS anylistEventId,
        skylight_sitting_id AS skylightSittingId,
        date,
        meal_time           AS mealTime,
        synced_at           AS syncedAt
      FROM meal_sitting_map
      WHERE anylist_event_id = ?
    `).get(anylistEventId) as MealSittingRecord | null;
  }

  upsertMealSitting(record: Omit<MealSittingRecord, 'id'>): void {
    this.db.prepare(`
      INSERT INTO meal_sitting_map
        (anylist_event_id, skylight_sitting_id, date, meal_time, synced_at)
      VALUES
        (@anylistEventId, @skylightSittingId, @date, @mealTime, @syncedAt)
      ON CONFLICT(anylist_event_id) DO UPDATE SET
        skylight_sitting_id = excluded.skylight_sitting_id,
        date                = excluded.date,
        meal_time           = excluded.meal_time,
        synced_at           = excluded.synced_at
    `).run(record);
  }

  deleteMealSittingByAnylistId(anylistEventId: string): void {
    this.db.prepare('DELETE FROM meal_sitting_map WHERE anylist_event_id = ?').run(anylistEventId);
  }

  close(): void {
    this.db.close();
    logger.info('State database closed');
  }
}
