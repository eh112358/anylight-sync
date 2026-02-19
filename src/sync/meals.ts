// Meal planning sync logic: AnyList meal events ↔ Skylight meal sittings.
//
// The workflow:
//   1. AnyList meal events (title + date) are the source of truth.
//   2. For each AnyList event, we find or create a matching recipe in Skylight's
//      recipe box (matched by title), then schedule a sitting for that date.
//   3. We only sync a rolling window of dates (today ± 30 days) to keep things manageable.
//   4. Meal sync only runs during the Skylight poll cycle (not real-time), since
//      meal plan changes are infrequent and the AnyList WebSocket event doesn't
//      include enough detail to act on immediately.

import type { AnyListClient } from '../anylist/client.js';
import type { AnyListMealEvent } from '../anylist/types.js';
import type { SkylightClient } from '../skylight/client.js';
import {
  createRecipe,
  deleteRecipe,
  getAllRecipes,
  getMealCategories,
  getMealSittings,
  scheduleMeal,
  deleteMealSitting,
} from '../skylight/endpoints/meals.js';
import { logger } from '../utils/logger.js';
import type { StateStore } from './state.js';

// How many days before and after today to sync
const SYNC_WINDOW_DAYS = 30;

function getTodayString(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const date = new Date(dateStr);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function eventDateString(event: AnyListMealEvent): string {
  return event.date.toISOString().slice(0, 10);
}

export async function syncMeals(
  anylistClient: AnyListClient,
  skylightClient: SkylightClient,
  state: StateStore
): Promise<void> {
  const today = getTodayString();
  const windowStart = addDays(today, -SYNC_WINDOW_DAYS);
  const windowEnd = addDays(today, SYNC_WINDOW_DAYS);

  logger.info('Syncing meal plan', { windowStart, windowEnd });

  // Fetch current state from both platforms
  const anylistEvents = await anylistClient.getMealEvents();
  const skylightSittings = await getMealSittings(skylightClient, windowStart, windowEnd);
  const skylightRecipes = await getAllRecipes(skylightClient);
  const mealCategories = await getMealCategories(skylightClient);

  // Filter AnyList events to just the sync window
  const eventsInWindow = anylistEvents.filter((event) => {
    const dateStr = eventDateString(event);
    return dateStr >= windowStart && dateStr <= windowEnd;
  });

  // Find the "Dinner" category as default — fall back to the first valid category.
  // Guard against categories with missing attributes — the API is unofficial and
  // may return malformed entries.
  const dinnerCategory =
    mealCategories.find((c) => c.attributes?.name?.toLowerCase() === 'dinner') ??
    mealCategories.find((c) => !!c.attributes?.name) ??
    mealCategories[0];

  if (!dinnerCategory) {
    logger.warn('No meal categories found in Skylight — skipping meal sync. Check your Skylight Plus subscription.');
    return;
  }

  // Build lookup maps
  const stateByAnylistId = new Map(
    state.getAllMealSittings().map((r) => [r.anylistEventId, r])
  );
  const recipesByTitle = new Map(
    skylightRecipes.map((r) => [r.attributes.summary.toLowerCase(), r])
  );
  const anylistEventIds = new Set(eventsInWindow.map((e) => e.identifier));

  // 1. AnyList → Skylight: add or update
  for (const event of eventsInWindow) {
    // Skip events with no title — we can't create a Skylight recipe without one
    if (!event.title) {
      logger.debug('Skipping meal event with no title', { identifier: event.identifier, date: eventDateString(event) });
      continue;
    }

    const existing = stateByAnylistId.get(event.identifier);

    if (!existing) {
      // New event — find or create the recipe, then schedule the sitting
      await handleNewMealEvent(
        event,
        skylightClient,
        state,
        recipesByTitle,
        dinnerCategory.id
      );
    } else {
      // Event exists — check if the date changed (title changes aren't synced
      // because we'd have to rename the recipe too, which is complex)
      const currentDate = eventDateString(event);
      if (existing.date !== currentDate) {
        logger.info('Meal event date changed — rescheduling in Skylight', {
          title: event.title,
          oldDate: existing.date,
          newDate: currentDate,
        });

        // Delete the old sitting and create a new one at the new date
        try {
          await deleteMealSitting(skylightClient, existing.skylightSittingId);
        } catch (error) {
          logger.warn('Could not delete old meal sitting — may already be gone', {
            sittingId: existing.skylightSittingId,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        // Find the recipe we already created for this event
        const recipe = skylightRecipes.find((r) => r.id === existing.skylightSittingId);
        const recipeId = recipe?.id ?? null;

        const newSitting = await scheduleMeal(
          skylightClient,
          currentDate,
          dinnerCategory.id,
          recipeId
        );

        state.upsertMealSitting({
          anylistEventId: event.identifier,
          skylightSittingId: newSitting.id,
          date: currentDate,
          mealTime: dinnerCategory.attributes?.name ?? null,
          syncedAt: Date.now(),
        });
      }
    }
  }

  // 2. Remove sittings whose AnyList events are no longer in the window or were deleted
  for (const [anylistEventId, stateRecord] of stateByAnylistId) {
    if (!anylistEventIds.has(anylistEventId)) {
      // Only remove sittings that fall within our sync window — don't touch old history
      if (stateRecord.date >= windowStart && stateRecord.date <= windowEnd) {
        logger.info('Meal event removed from AnyList — removing Skylight sitting', {
          anylistEventId,
          date: stateRecord.date,
        });

        try {
          await deleteMealSitting(skylightClient, stateRecord.skylightSittingId);
        } catch (error) {
          logger.warn('Could not delete Skylight meal sitting (may already be gone)', {
            sittingId: stateRecord.skylightSittingId,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        state.deleteMealSittingByAnylistId(anylistEventId);
      }
    }
  }
}

async function handleNewMealEvent(
  event: AnyListMealEvent,
  skylightClient: SkylightClient,
  state: StateStore,
  recipesByTitle: Map<string, { id: string; attributes: { summary: string } }>,
  defaultCategoryId: string
): Promise<void> {
  const dateStr = eventDateString(event);
  logger.info('New meal event in AnyList — syncing to Skylight', {
    title: event.title,
    date: dateStr,
  });

  // Find an existing recipe with this title, or create a new one
  let recipeId: string;
  const existingRecipe = recipesByTitle.get(event.title.toLowerCase());

  if (existingRecipe) {
    recipeId = existingRecipe.id;
    logger.debug('Reusing existing Skylight recipe', { title: event.title, recipeId });
  } else {
    logger.info('Creating new Skylight recipe', { title: event.title });
    const newRecipe = await createRecipe(
      skylightClient,
      event.title,
      defaultCategoryId
    );
    recipeId = newRecipe.id;
    recipesByTitle.set(event.title.toLowerCase(), newRecipe);

    state.upsertRecipe({
      anylistEventId: event.identifier,
      skylightRecipeId: newRecipe.id,
      title: event.title,
      syncedAt: Date.now(),
    });
  }

  // Schedule the meal sitting
  const sitting = await scheduleMeal(skylightClient, dateStr, defaultCategoryId, recipeId);

  state.upsertMealSitting({
    anylistEventId: event.identifier,
    skylightSittingId: sitting.id,
    date: dateStr,
    mealTime: null,
    syncedAt: Date.now(),
  });
}
