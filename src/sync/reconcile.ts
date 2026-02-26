// Startup reconciliation.
//
// Runs once when the service starts. It compares the live state from both
// platforms against our SQLite state and resolves any drift — AnyList wins all conflicts.
//
// The key challenge on a fresh start (empty state DB): both platforms may already
// have the same items. We must NOT duplicate them. So we:
//   Pass 1 — Match existing items by label and record pairings in state
//   Pass 2 — Delete Skylight items with no AnyList counterpart
//
// This must call refreshLists() to get current AnyList data, since connect()
// only does an initial load.

import type { AnyListClient } from '../anylist/client.js';
import type { ListSyncPair } from '../config.js';
import type { SkylightClient } from '../skylight/client.js';
import { addItem, deleteItem, getListWithItems } from '../skylight/endpoints/lists.js';
import { findOrCreateSkylightList } from './lists.js';
import { logger } from '../utils/logger.js';
import type { StateStore } from './state.js';

export async function reconcileOnStartup(
  anylistClient: AnyListClient,
  skylightClient: SkylightClient,
  state: StateStore,
  listSyncPairs: ListSyncPair[]
): Promise<Map<string, string>> {
  logger.info('Starting reconciliation — aligning both platforms against current AnyList state');

  // Get fresh AnyList data before we start comparing anything
  await anylistClient.refreshLists();

  // Maps anylist list name → skylight list ID (returned for use in the main sync loop)
  const skylightListIds = new Map<string, string>();

  for (const pair of listSyncPairs) {
    logger.info('Reconciling list pair', {
      anylistList: pair.anylistName,
      skylightList: pair.skylightName,
    });

    // Ensure the Skylight list exists (creates it if missing)
    const skylightListId = await findOrCreateSkylightList(skylightClient, pair.skylightName);
    skylightListIds.set(pair.anylistName, skylightListId);

    const anylistList = anylistClient.getListByName(pair.anylistName);
    if (!anylistList) {
      logger.warn('AnyList list not found during reconciliation — skipping', {
        listName: pair.anylistName,
      });
      continue;
    }

    const { items: skylightItems } = await getListWithItems(skylightClient, skylightListId);

    // Find which items are already tracked in state for this list
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

    // Build a label → Skylight item map for items not yet tracked in state.
    // Used to match AnyList items to existing Skylight items by label.
    const unknownSkylightByLabel = new Map(
      skylightItems
        .filter((i) => !knownSkylightIds.has(i.id))
        .map((i) => [i.attributes.label.toLowerCase().trim(), i])
    );

    // --- Pass 1: For each AnyList item, match to an existing Skylight item or create one ---
    for (const anylistItem of anylistList.items) {
      if (knownAnylistIds.has(anylistItem.identifier)) {
        continue; // already tracked — nothing to do
      }

      const label = anylistItem.quantity
        ? `${anylistItem.quantity} ${anylistItem.name}`
        : anylistItem.name;
      const status = anylistItem.checked ? 'completed' : 'pending';
      const matchedSkylightItem = unknownSkylightByLabel.get(label.toLowerCase().trim());

      if (matchedSkylightItem) {
        // Same item already exists on both sides — record the pairing, don't duplicate it
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
        // Item only exists in AnyList — create it in Skylight
        logger.info('Item in AnyList but not Skylight — creating in Skylight', { label });
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

    // --- Pass 2: Remove Skylight items with no AnyList counterpart ---
    // Anything still in unknownSkylightByLabel was not matched to an AnyList item.
    // Since AnyList is the source of truth, remove them from Skylight.
    for (const [, skylightItem] of unknownSkylightByLabel) {
      logger.info('Item in Skylight but not AnyList — removing from Skylight', {
        label: skylightItem.attributes.label,
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

    logger.info('List pair reconciliation complete', {
      anylistList: pair.anylistName,
      skylightList: pair.skylightName,
    });
  }

  logger.info('Startup reconciliation complete');
  return skylightListIds;
}
