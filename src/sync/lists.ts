// Shopping list sync logic.
//
// The main export is syncListPair(), which handles one full bidirectional sync
// cycle for a single list pair. It:
//   1. Refreshes AnyList data from the API (critical — avoids stale cache)
//   2. Fetches current Skylight list state
//   3. Pushes AnyList changes → Skylight
//   4. Pushes Skylight changes → AnyList (skipping echoes of what we just wrote)
//
// AnyList is the source of truth. If both sides changed the same item, the
// AnyList version wins.

import type { AnyListClient } from '../anylist/client.js';
import type { AnyListItem, AnyListList } from '../anylist/types.js';
import type { ListSyncPair } from '../config.js';
import type { SkylightClient } from '../skylight/client.js';
import { addItem, createList, deleteItem, getAllLists, getListWithItems, updateItem } from '../skylight/endpoints/lists.js';
import type { SkylightListItem } from '../skylight/types.js';
import { logger } from '../utils/logger.js';
import type { StateStore } from './state.js';

// Skylight has no quantity field, so we encode it in the label.
// e.g., AnyList { name: "Ground Beef", quantity: "2 lbs" } → Skylight label: "2 lbs Ground Beef"
function buildSkylightLabel(item: AnyListItem): string {
  return item.quantity ? `${item.quantity} ${item.name}` : item.name;
}

function toStatus(checked: boolean): 'pending' | 'completed' {
  return checked ? 'completed' : 'pending';
}

// --- Main entry point ---

// Runs one full bidirectional sync cycle for a single list pair.
// Call this from the poll loop and from the WebSocket event handler.
export async function syncListPair(
  pair: ListSyncPair,
  skylightListId: string,
  anylistClient: AnyListClient,
  skylightClient: SkylightClient,
  state: StateStore
): Promise<void> {
  // Step 1: Force a fresh fetch of AnyList data from the API.
  // Without this, getListByName() returns the in-memory cache from startup,
  // which goes stale as soon as the WebSocket disconnects (~14s after start).
  await anylistClient.refreshLists();

  const anylistList = anylistClient.getListByName(pair.anylistName);
  if (!anylistList) {
    logger.warn('AnyList list not found during sync — skipping', {
      listName: pair.anylistName,
    });
    return;
  }

  // Step 2: Fetch current Skylight state (always a live HTTP call)
  const { items: skylightItems } = await getListWithItems(skylightClient, skylightListId);

  logger.info('Syncing list pair', {
    anylistList: pair.anylistName,
    anylistItemCount: anylistList.items.length,
    skylightItemCount: skylightItems.length,
  });

  // Step 3: Push AnyList changes → Skylight (runs first so echoes are detectable)
  await syncAnyListToSkylight(anylistList, skylightListId, skylightClient, state);

  // Step 4: Push Skylight changes → AnyList (skips echoes of what we just wrote)
  await syncSkylightToAnyList(skylightItems, skylightListId, pair, anylistList.identifier, anylistClient, state);
}

// --- AnyList → Skylight ---

async function syncAnyListToSkylight(
  anylistList: AnyListList,
  skylightListId: string,
  skylightClient: SkylightClient,
  state: StateStore
): Promise<void> {
  const allStateItems = state.getAllListItems();
  const stateByAnylistId = new Map(
    allStateItems
      .filter((r) => r.anylistListId === anylistList.identifier)
      .map((r) => [r.anylistItemId, r])
  );

  const anylistItemIds = new Set(anylistList.items.map((i) => i.identifier));

  // New items: in AnyList but not tracked in state
  for (const item of anylistList.items) {
    if (!stateByAnylistId.has(item.identifier)) {
      const label = buildSkylightLabel(item);
      const status = toStatus(item.checked);

      logger.info('New item in AnyList — adding to Skylight', { label });
      const skylightItem = await addItem(skylightClient, skylightListId, label);

      if (item.checked) {
        await updateItem(skylightClient, skylightListId, skylightItem.id, { status: 'completed' });
      }

      state.upsertListItem({
        anylistItemId: item.identifier,
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

  // Changed items: in both, but label or status differs from what we last synced
  for (const item of anylistList.items) {
    const stateRecord = stateByAnylistId.get(item.identifier);
    if (!stateRecord) continue; // new — handled above

    const currentLabel = buildSkylightLabel(item);
    const currentStatus = toStatus(item.checked);
    const labelChanged = stateRecord.label !== currentLabel;
    const statusChanged = stateRecord.status !== currentStatus;

    if (labelChanged || statusChanged) {
      logger.info('Item changed in AnyList — updating Skylight', {
        label: currentLabel,
        labelChanged,
        statusChanged,
      });

      await updateItem(skylightClient, skylightListId, stateRecord.skylightItemId, {
        ...(labelChanged ? { label: currentLabel } : {}),
        ...(statusChanged ? { status: currentStatus } : {}),
      });

      state.upsertListItem({
        ...stateRecord,
        label: currentLabel,
        status: currentStatus,
        syncedAt: Date.now(),
        lastWriteSource: 'anylist',
      });
    }
  }

  // Deleted items: tracked in state but no longer in AnyList
  for (const [anylistItemId, stateRecord] of stateByAnylistId) {
    if (!anylistItemIds.has(anylistItemId)) {
      logger.info('Item removed from AnyList — deleting from Skylight', {
        label: stateRecord.label,
      });

      try {
        await deleteItem(skylightClient, skylightListId, stateRecord.skylightItemId);
      } catch (error) {
        // If it's already gone from Skylight, that's fine — just clean up state
        logger.warn('Could not delete Skylight item (may already be gone)', {
          skylightItemId: stateRecord.skylightItemId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      state.deleteListItemByAnylistId(anylistItemId);
    }
  }
}

// --- Skylight → AnyList ---

async function syncSkylightToAnyList(
  skylightItems: SkylightListItem[],
  skylightListId: string,
  pair: ListSyncPair,
  anylistListId: string,
  anylistClient: AnyListClient,
  state: StateStore
): Promise<void> {
  const allStateItems = state.getAllListItems();
  const stateBySkylightId = new Map(
    allStateItems
      .filter((r) => r.skylightListId === skylightListId)
      .map((r) => [r.skylightItemId, r])
  );

  const skylightItemIds = new Set(skylightItems.map((i) => i.id));

  // New items: in Skylight but not tracked in state
  for (const item of skylightItems) {
    if (!stateBySkylightId.has(item.id)) {
      const label = item.attributes.label;
      const status = item.attributes.status;

      logger.info('New item in Skylight — adding to AnyList', { label });
      const newAnylistItem = await anylistClient.addItem(pair.anylistName, label);

      if (status === 'completed') {
        await anylistClient.updateItemChecked(pair.anylistName, newAnylistItem.identifier, true);
      }

      state.upsertListItem({
        anylistItemId: newAnylistItem.identifier,
        skylightItemId: item.id,
        anylistListId,
        skylightListId,
        label,
        status,
        syncedAt: Date.now(),
        lastWriteSource: 'skylight',
      });
    }
  }

  // Changed items: in both, but status or label changed — skip echoes
  for (const item of skylightItems) {
    const stateRecord = stateBySkylightId.get(item.id);
    if (!stateRecord) continue; // new — handled above

    // If we wrote this change to Skylight recently, it's an echo of our own action — skip it
    if (state.isEchoFromRecentWrite(item.id)) {
      logger.debug('Skipping Skylight item — echo of recent write', {
        label: item.attributes.label,
      });
      continue;
    }

    const currentStatus = item.attributes.status;
    const currentLabel = item.attributes.label;
    const statusChanged = stateRecord.status !== currentStatus;
    const labelChanged = stateRecord.label !== currentLabel;

    if (statusChanged || labelChanged) {
      logger.info('Item changed in Skylight — updating AnyList', {
        label: currentLabel,
        statusChanged,
        labelChanged,
      });

      if (statusChanged) {
        await anylistClient.updateItemChecked(
          pair.anylistName,
          stateRecord.anylistItemId,
          currentStatus === 'completed'
        );
      }
      if (labelChanged) {
        await anylistClient.updateItemName(
          pair.anylistName,
          stateRecord.anylistItemId,
          currentLabel
        );
      }

      state.upsertListItem({
        ...stateRecord,
        label: currentLabel,
        status: currentStatus,
        syncedAt: Date.now(),
        lastWriteSource: 'skylight',
      });
    }
  }

  // Deleted items: tracked in state but no longer in Skylight
  for (const [skylightItemId, stateRecord] of stateBySkylightId) {
    if (!skylightItemIds.has(skylightItemId)) {
      // If we deleted this ourselves (AnyList → Skylight direction), it's an echo — just clean up
      if (state.isEchoFromRecentWrite(skylightItemId)) {
        logger.debug('Skipping Skylight deletion — echo of our own delete', {
          label: stateRecord.label,
        });
        state.deleteListItemBySkylightId(skylightItemId);
        continue;
      }

      logger.info('Item removed from Skylight — removing from AnyList', {
        label: stateRecord.label,
      });

      try {
        await anylistClient.removeItem(pair.anylistName, stateRecord.anylistItemId);
      } catch (error) {
        logger.warn('Could not remove AnyList item (may already be gone)', {
          anylistItemId: stateRecord.anylistItemId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      state.deleteListItemBySkylightId(skylightItemId);
    }
  }
}

// --- Utility: find or create a Skylight list by name ---
// Used by reconcile.ts during startup.

export async function findOrCreateSkylightList(
  client: SkylightClient,
  listName: string
): Promise<string> {
  const allLists = await getAllLists(client);
  const existing = allLists.find(
    (list) => list.attributes.label.toLowerCase() === listName.toLowerCase()
  );

  if (existing) {
    logger.info('Found existing Skylight list', { name: listName, id: existing.id });
    return existing.id;
  }

  logger.info('Skylight list not found — creating it', { name: listName });
  const newList = await createList(client, listName);
  logger.info('Created Skylight list', { name: listName, id: newList.id });
  return newList.id;
}
