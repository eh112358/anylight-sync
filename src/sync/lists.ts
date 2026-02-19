// Shopping list sync logic.
//
// There are two sync directions:
//
//  1. AnyList → Skylight (triggered by AnyList WebSocket events, near real-time)
//     When AnyList fires a "lists-update" event, we compare the current AnyList
//     items against our SQLite snapshot and push any differences to Skylight.
//
//  2. Skylight → AnyList (triggered by the polling loop, every SYNC_INTERVAL_MS)
//     We fetch the current Skylight items, compare against SQLite, and push
//     differences to AnyList — unless we detect the change is just an echo of
//     something we wrote to Skylight ourselves recently.
//
// AnyList is the source of truth. If both sides changed the same item, the
// AnyList version is used.

import type { AnyListClient } from '../anylist/client.js';
import type { AnyListItem, AnyListList } from '../anylist/types.js';
import type { SkylightClient } from '../skylight/client.js';
import { addItem, createList, deleteItem, getAllLists, getListWithItems, updateItem } from '../skylight/endpoints/lists.js';
import type { SkylightListItem } from '../skylight/types.js';
import { logger } from '../utils/logger.js';
import type { StateStore } from './state.js';

// Skylight has no quantity field, so we encode quantity in the label.
// e.g., AnyList { name: "Ground Beef", quantity: "2 lbs" } → Skylight label: "2 lbs Ground Beef"
function buildSkylightLabel(item: AnyListItem): string {
  return item.quantity ? `${item.quantity} ${item.name}` : item.name;
}

function toStatus(checked: boolean): 'pending' | 'completed' {
  return checked ? 'completed' : 'pending';
}

// --- AnyList → Skylight ---

export async function syncAnyListToSkylight(
  anylistList: AnyListList,
  skylightListId: string,
  skylightClient: SkylightClient,
  state: StateStore
): Promise<void> {
  logger.info('Syncing AnyList → Skylight', {
    anylistList: anylistList.name,
    skylightListId,
  });

  // Build a map of what we have in state for this AnyList list
  const allStateItems = state.getAllListItems();
  const stateByAnylistId = new Map(
    allStateItems
      .filter((r) => r.anylistListId === anylistList.identifier)
      .map((r) => [r.anylistItemId, r])
  );

  const anylistItemIds = new Set(anylistList.items.map((i) => i.identifier));

  // 1. Find new items (in AnyList but not in state)
  for (const item of anylistList.items) {
    if (!stateByAnylistId.has(item.identifier)) {
      await handleNewItemFromAnyList(item, anylistList, skylightListId, skylightClient, state);
    }
  }

  // 2. Find updated items (in both, but label or status changed)
  for (const item of anylistList.items) {
    const stateRecord = stateByAnylistId.get(item.identifier);
    if (!stateRecord) continue; // handled above as new

    const currentLabel = buildSkylightLabel(item);
    const currentStatus = toStatus(item.checked);
    const labelChanged = stateRecord.label !== currentLabel;
    const statusChanged = stateRecord.status !== currentStatus;

    if (labelChanged || statusChanged) {
      logger.info('Item changed in AnyList — updating Skylight', {
        itemId: item.identifier,
        labelChanged,
        statusChanged,
      });

      await updateItem(skylightClient, skylightListId, stateRecord.skylightItemId, {
        ...(labelChanged ? { label: currentLabel } : {}),
        ...(statusChanged ? { status: currentStatus } : {}),
      });

      state.upsertListItem({
        anylistItemId: item.identifier,
        skylightItemId: stateRecord.skylightItemId,
        anylistListId: anylistList.identifier,
        skylightListId,
        label: currentLabel,
        status: currentStatus,
        syncedAt: Date.now(),
        lastWriteSource: 'anylist',
      });
    }
  }

  // 3. Find deleted items (in state but no longer in AnyList)
  for (const [anylistItemId, stateRecord] of stateByAnylistId) {
    if (!anylistItemIds.has(anylistItemId)) {
      logger.info('Item removed from AnyList — deleting from Skylight', { anylistItemId });

      try {
        await deleteItem(skylightClient, skylightListId, stateRecord.skylightItemId);
      } catch (error) {
        // If the item was already gone from Skylight, that's fine — just clean up state
        logger.warn('Could not delete Skylight item (may already be gone)', {
          skylightItemId: stateRecord.skylightItemId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      state.deleteListItemByAnylistId(anylistItemId);
    }
  }
}

async function handleNewItemFromAnyList(
  item: AnyListItem,
  anylistList: AnyListList,
  skylightListId: string,
  skylightClient: SkylightClient,
  state: StateStore
): Promise<void> {
  const label = buildSkylightLabel(item);
  const status = toStatus(item.checked);

  logger.info('New item in AnyList — adding to Skylight', { label });

  const skylightItem = await addItem(skylightClient, skylightListId, label);

  // If the item was already checked in AnyList, mark it completed in Skylight too
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

// --- Skylight → AnyList ---

export async function syncSkylightToAnyList(
  skylightListId: string,
  anylistListName: string,
  anylistListId: string,
  anylistClient: AnyListClient,
  skylightClient: SkylightClient,
  state: StateStore
): Promise<void> {
  logger.info('Syncing Skylight → AnyList', {
    skylightListId,
    anylistListName,
  });

  const { items: skylightItems } = await getListWithItems(skylightClient, skylightListId);

  const allStateItems = state.getAllListItems();
  const stateBySkylightId = new Map(
    allStateItems
      .filter((r) => r.skylightListId === skylightListId)
      .map((r) => [r.skylightItemId, r])
  );

  const skylightItemIds = new Set(skylightItems.map((i) => i.id));

  // 1. Find new items in Skylight (not in state)
  for (const item of skylightItems) {
    if (!stateBySkylightId.has(item.id)) {
      await handleNewItemFromSkylight(
        item,
        skylightListId,
        anylistListName,
        anylistListId,
        anylistClient,
        state
      );
    }
  }

  // 2. Find updated items — but skip echoes of changes we just made
  for (const item of skylightItems) {
    const stateRecord = stateBySkylightId.get(item.id);
    if (!stateRecord) continue; // handled above

    // If this looks like an echo of something we wrote to Skylight recently, skip it
    if (state.isEchoFromRecentWrite(item.id)) {
      logger.debug('Skipping Skylight item change — looks like echo of recent write', {
        skylightItemId: item.id,
      });
      continue;
    }

    const currentStatus = item.attributes.status;
    const currentLabel = item.attributes.label;
    const statusChanged = stateRecord.status !== currentStatus;
    const labelChanged = stateRecord.label !== currentLabel;

    if (statusChanged || labelChanged) {
      logger.info('Item changed in Skylight — updating AnyList', {
        itemId: item.id,
        statusChanged,
        labelChanged,
      });

      if (statusChanged) {
        await anylistClient.updateItemChecked(
          anylistListName,
          stateRecord.anylistItemId,
          currentStatus === 'completed'
        );
      }
      if (labelChanged) {
        await anylistClient.updateItemName(
          anylistListName,
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

  // 3. Find items deleted from Skylight (in state but not in current Skylight response)
  for (const [skylightItemId, stateRecord] of stateBySkylightId) {
    if (!skylightItemIds.has(skylightItemId)) {
      // Skip if we recently deleted this ourselves (AnyList → Skylight direction)
      if (state.isEchoFromRecentWrite(skylightItemId)) {
        logger.debug('Skipping Skylight deletion — looks like echo of our own delete', {
          skylightItemId,
        });
        state.deleteListItemBySkylightId(skylightItemId);
        continue;
      }

      logger.info('Item removed from Skylight — removing from AnyList', { skylightItemId });

      try {
        await anylistClient.removeItem(anylistListName, stateRecord.anylistItemId);
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

async function handleNewItemFromSkylight(
  item: SkylightListItem,
  skylightListId: string,
  anylistListName: string,
  anylistListId: string,
  anylistClient: AnyListClient,
  state: StateStore
): Promise<void> {
  const label = item.attributes.label;
  const status = item.attributes.status;

  logger.info('New item in Skylight — adding to AnyList', { label });

  const newAnylistItem = await anylistClient.addItem(anylistListName, label);

  if (status === 'completed') {
    await anylistClient.updateItemChecked(anylistListName, newAnylistItem.identifier, true);
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

// --- Utility: find or create a Skylight list by name ---

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
