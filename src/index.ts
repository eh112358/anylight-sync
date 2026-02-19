// Entry point for the AnyList ↔ Skylight sync service.
//
// Startup sequence:
//   1. Load and validate config
//   2. Open the SQLite state database
//   3. Connect to AnyList (WebSocket)
//   4. Log in to Skylight
//   5. Reconcile: bring both platforms in sync using AnyList as source of truth
//   6. Start listening for AnyList changes (WebSocket push)
//   7. Start the Skylight polling loop
//
// On shutdown (SIGINT or SIGTERM), cleanly disconnect before exiting.

import { loadConfig } from './config.js';
import { AnyListClient } from './anylist/client.js';
import { SkylightClient } from './skylight/client.js';
import { StateStore } from './sync/state.js';
import { reconcileOnStartup } from './sync/reconcile.js';
import { syncAnyListToSkylight, syncSkylightToAnyList } from './sync/lists.js';
import { logger } from './utils/logger.js';

// Debounce: if AnyList fires multiple list-update events in quick succession
// (e.g. the user checks off several items), we wait this long before actually
// running the sync — avoids hammering Skylight with one request per tap.
const ANYLIST_DEBOUNCE_MS = 2000;

async function main(): Promise<void> {
  const config = loadConfig();

  // --- Initialize state database ---
  const state = new StateStore(config.stateDbPath);

  // --- Connect to AnyList ---
  const anylistClient = new AnyListClient(config.anylist.email, config.anylist.password);
  await anylistClient.connect();

  // --- Connect to Skylight ---
  const skylightClient = new SkylightClient(
    config.skylight.email,
    config.skylight.password,
    config.skylight.frameId
  );
  await skylightClient.login();

  // --- Startup reconciliation ---
  // Returns a map of anylist list name → skylight list ID, which we reuse throughout
  const skylightListIds = await reconcileOnStartup(
    anylistClient,
    skylightClient,
    state,
    config.listSyncPairs
  );

  // --- AnyList WebSocket listener ---
  // The anylist package fires 'lists-update' whenever any list changes.
  // We debounce it to avoid rapid-fire syncs when many items change at once.
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  anylistClient.onListsUpdate((updatedLists) => {
    if (debounceTimer) clearTimeout(debounceTimer);

    debounceTimer = setTimeout(async () => {
      logger.info('AnyList change detected — running sync');

      for (const pair of config.listSyncPairs) {
        const skylightListId = skylightListIds.get(pair.anylistName);
        if (!skylightListId) {
          logger.warn('No Skylight list ID found for AnyList list — skipping', {
            anylistList: pair.anylistName,
          });
          continue;
        }

        const updatedList = updatedLists.find((l) => l.name === pair.anylistName);
        if (!updatedList) {
          logger.debug('Updated list not in sync pairs — skipping', { pair });
          continue;
        }

        try {
          await syncAnyListToSkylight(updatedList, skylightListId, skylightClient, state);
        } catch (error) {
          logger.error('Error syncing AnyList → Skylight', {
            list: pair.anylistName,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }, ANYLIST_DEBOUNCE_MS);
  });

  // --- Skylight polling loop ---
  // Polls both platforms every SYNC_INTERVAL_MS.
  //
  // This handles two things:
  //   1. AnyList → Skylight: catches any AnyList changes that the WebSocket missed
  //      (the WebSocket drops frequently due to timeouts, so polling is the reliable fallback)
  //   2. Skylight → AnyList: the only way to detect changes made on the Skylight frame
  async function runSkylightPoll(): Promise<void> {
    logger.info('Running poll cycle');

    for (const pair of config.listSyncPairs) {
      const skylightListId = skylightListIds.get(pair.anylistName);
      if (!skylightListId) continue;

      const anylistList = anylistClient.getListByName(pair.anylistName);
      if (!anylistList) {
        logger.warn('AnyList list not found during poll — skipping', {
          listName: pair.anylistName,
        });
        continue;
      }

      // AnyList → Skylight (catches changes missed by the WebSocket)
      try {
        await syncAnyListToSkylight(anylistList, skylightListId, skylightClient, state);
      } catch (error) {
        logger.error('Error syncing AnyList → Skylight during poll', {
          list: pair.anylistName,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Skylight → AnyList
      try {
        await syncSkylightToAnyList(
          skylightListId,
          pair.anylistName,
          anylistList.identifier,
          anylistClient,
          skylightClient,
          state
        );
      } catch (error) {
        logger.error('Error syncing Skylight → AnyList', {
          list: pair.anylistName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Meal plan sync is temporarily disabled — see meals.ts for details
  }

  // Run the first poll immediately, then schedule recurring polls
  await runSkylightPoll();
  const pollInterval = setInterval(runSkylightPoll, config.syncIntervalMs);

  logger.info('Sync service is running', {
    pollIntervalMs: config.syncIntervalMs,
    lists: config.listSyncPairs.map((p) => `${p.anylistName} ↔ ${p.skylightName}`),
  });

  // --- Graceful shutdown ---
  function shutdown(signal: string): void {
    logger.info(`Received ${signal} — shutting down gracefully`);

    if (debounceTimer) clearTimeout(debounceTimer);
    clearInterval(pollInterval);

    anylistClient.disconnect();
    state.close();

    logger.info('Shutdown complete');
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Log unhandled errors rather than crashing silently
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection — this is a bug, please report it', {
      reason: reason instanceof Error ? reason.message : String(reason),
    });
  });
}

main().catch((error) => {
  logger.error('Fatal error during startup', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
