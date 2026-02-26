// Entry point for the AnyList ↔ Skylight sync service.
//
// Startup sequence:
//   1. Load and validate config
//   2. Open the SQLite state database
//   3. Connect to AnyList (WebSocket)
//   4. Log in to Skylight
//   5. Reconcile: align both platforms with AnyList as source of truth
//   6. Register WebSocket listener (triggers an immediate poll when AnyList changes)
//   7. Run the first poll cycle immediately
//   8. Schedule recurring poll cycles every SYNC_INTERVAL_MS
//
// How syncing works:
//   Every poll cycle calls syncListPair() for each configured list pair.
//   syncListPair() always starts by calling refreshLists() to get fresh AnyList
//   data from the API — this is the critical step that makes AnyList changes
//   visible without restarting the service.
//
//   The AnyList WebSocket, when it works, triggers an extra poll immediately
//   when a change is detected. When it drops (frequently), the scheduled
//   poll loop catches changes within SYNC_INTERVAL_MS.

import { loadConfig } from './config.js';
import { AnyListClient } from './anylist/client.js';
import { SkylightClient } from './skylight/client.js';
import { StateStore } from './sync/state.js';
import { reconcileOnStartup } from './sync/reconcile.js';
import { syncListPair } from './sync/lists.js';
import { logger } from './utils/logger.js';

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
  // Aligns both platforms. Returns a map of anylist list name → skylight list ID.
  const skylightListIds = await reconcileOnStartup(
    anylistClient,
    skylightClient,
    state,
    config.listSyncPairs
  );

  // --- Poll cycle ---
  // Syncs all configured list pairs. Called on a schedule and also immediately
  // when the AnyList WebSocket fires a change event.
  //
  // Guard flag prevents overlapping poll cycles if one takes longer than the interval.
  let pollRunning = false;

  async function runPollCycle(): Promise<void> {
    if (pollRunning) {
      logger.debug('Poll cycle already running — skipping this trigger');
      return;
    }
    pollRunning = true;

    logger.info('Running poll cycle');

    try {
      for (const pair of config.listSyncPairs) {
        const skylightListId = skylightListIds.get(pair.anylistName);
        if (!skylightListId) {
          logger.warn('No Skylight list ID for pair — skipping', {
            anylistList: pair.anylistName,
          });
          continue;
        }

        try {
          await syncListPair(pair, skylightListId, anylistClient, skylightClient, state);
        } catch (error) {
          logger.error('Error syncing list pair', {
            anylistList: pair.anylistName,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      pollRunning = false;
    }
  }

  // --- AnyList WebSocket listener ---
  // When the WebSocket fires a change event, trigger an immediate poll.
  // The poll cycle calls refreshLists() itself, so we don't use the event
  // data directly — it could be incomplete if the WebSocket partially dropped.
  anylistClient.onListsUpdate(() => {
    logger.info('AnyList WebSocket change detected — triggering immediate poll');
    runPollCycle().catch((error) => {
      logger.error('Error in WebSocket-triggered poll cycle', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  // Run the first poll cycle immediately after reconciliation, then on schedule
  await runPollCycle();
  const pollInterval = setInterval(() => {
    runPollCycle().catch((error) => {
      logger.error('Error in scheduled poll cycle', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, config.syncIntervalMs);

  logger.info('Sync service is running', {
    pollIntervalMs: config.syncIntervalMs,
    lists: config.listSyncPairs.map((p) => `${p.anylistName} ↔ ${p.skylightName}`),
  });

  // --- Graceful shutdown ---
  function shutdown(signal: string): void {
    logger.info(`Received ${signal} — shutting down gracefully`);

    clearInterval(pollInterval);
    anylistClient.disconnect();
    state.close();

    logger.info('Shutdown complete');
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Crash the process on unhandled errors so Kubernetes restarts the pod.
  // A pod restart is safer than silently continuing in an unknown state.
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection — restarting', {
      reason: reason instanceof Error ? reason.message : String(reason),
    });
    process.exit(1);
  });
}

main().catch((error) => {
  logger.error('Fatal error during startup', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
