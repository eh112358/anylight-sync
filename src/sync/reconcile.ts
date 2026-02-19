// Startup reconciliation.
//
// This runs once when the service starts (including after a crash).
// It compares the live state from both platforms against the last known SQLite
// state, and resolves any drift — with AnyList winning all conflicts.
//
// The key challenge on a fresh start with an empty state DB: both platforms
// may already have the same items. We must NOT duplicate them. So we first
// match up existing items by label, record those pairings in state, and only
// create/delete items that are genuinely missing from one side.

import type { AnyListClient } from '../anylist/client.js';
import type { ListSyncPair } from '../config.js';
import type { SkylightClient } from '../skylight/client.js';
import { findOrCreateSkylightList } from './lists.js';
import { addItem, deleteItem, getListWithItems } from '../skylight/endpoints/lists.js';
import { logger } from '../utils/logger.js';
import type { StateStore } from './state.js';

export async function reconcileOnStartup(
  anylistClient: AnyListClient,
  skylightClient: SkylightClient,
  state: StateStore,
  listSyncPairs: ListSyncPair[]
): Promise<Map<string, string>> {
  logger.info('Starting up — reconciling state against live platforms');

  // Maps anylist list name → skylight list ID (used by the main sync loop)
  const skylightListIds = new Map<string, string>();

  for (const pair of listSyncPairs) {
    logger.info('Reconciling list pair', {
      anylistList: pair.anylistName,
      skylightList: pair.skylightName,
    });

    // Make sure the Skylight list exists (create it if not)
    const skylightListId = await findOrCreateSkylightList(skylightClient, pair.skylightName);
    skylightListIds.set(pair.anylistName, skylightListId);

    // Get current live state from both platforms
    const anylistList = anylistClient.getListByName(pair.anylistName);
    if (!anylistList) {
      logger.warn('AnyList list not found during reconciliation — skipping', {
        listName: pair.anylistName,
      });
      continue;
    }

    const { items: skylightItems } = await getListWithItems(skylightClient, skylightListId);

    // Find which items are already tracked in our state DB for this list
    const allStateItems = state.getAllListItems();
    const knownAnylistIds = new Set(
      allStateItems
        .filter((r) => r.anylistListId === anylistList.identifier)
        .map((r) => r.anylistItemId)
    );
    const knownSkylightIds = new Set(
      allStateItems
        .filter((r) => r.skylightListId === skylightListId)
        .map((r) => r.skylightItemId)
    );

    // Build a label → Skylight item lookup for items not yet in our state.
    // Used to match AnyList items to existing Skylight items instead of duplicating them.
    const unknownSkylightByLabel = new Map(
      skylightItems
        .filter((i) => !knownSkylightIds.has(i.id))
        .map((i) => [i.attributes.label.toLowerCase().trim(), i])
    );

    // --- Pass 1: For each AnyList item, either match it to an existing Skylight item
    //             or create a new one ---
    for (const anylistItem of anylistList.items) {
      if (knownAnylistIds.has(anylistItem.identifier)) {
        continue; // already tracked in state — nothing to do
      }

      const label = anylistItem.quantity
        ? `${anylistItem.quantity} ${anylistItem.name}`
        : anylistItem.name;
      const status = anylistItem.checked ? 'completed' : 'pending';
      const matchedSkylightItem = unknownSkylightByLabel.get(label.toLowerCase().trim());

      if (matchedSkylightItem) {
        // Same item already exists on both sides — record the pairing, don't duplicate
        logger.info('Matched existing item between AnyList and Skylight', { label });
        state.upsertListItem({
          anylistItemId: anylistItem.identifier,
          skylightItemId: matchedSkylightItem.id,
          anylistListId: anylistList.identifier,
          skylightListId,
          label,
          status,
          syncedAt: Date.now(),
          lastWriteSource: 'anylist',
        });
        unknownSkylightByLabel.delete(label.toLowerCase().trim());
      } else {
        // Item exists in AnyList but not in Skylight — create it
        logger.info('New item in AnyList — adding to Skylight during reconciliation', { label });
        const skylightItem = await addItem(skylightClient, skylightListId, label);
        state.upsertListItem({
          anylistItemId: anylistItem.identifier,
          skylightItemId: skylightItem.id,
          anylistListId: anylistList.identifier,
          skylightListId,
          label,
          status,
          syncedAt: Date.now(),
          lastWriteSource: 'anylist',
        });
      }
    }

    // --- Pass 2: Delete any Skylight items that have no AnyList counterpart ---
    // Anything still in unknownSkylightByLabel at this point was not matched
    // to any AnyList item. Since AnyList is the source of truth, delete them.
    for (const [, skylightItem] of unknownSkylightByLabel) {
      logger.info('Removing Skylight item with no AnyList counterpart', {
        label: skylightItem.attributes.label,
        skylightItemId: skylightItem.id,
      });
      try {
        await deleteItem(skylightClient, skylightListId, skylightItem.id);
      } catch (error) {
        logger.warn('Could not delete unmatched Skylight item (may already be gone)', {
          skylightItemId: skylightItem.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info('List reconciliation complete', { listName: pair.anylistName });
  }

  // Meal plan sync is temporarily disabled

  logger.info('Startup reconciliation complete');
  return skylightListIds;
}
