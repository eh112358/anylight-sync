// Loads and validates all environment variables at startup.
// If a required variable is missing, the process exits immediately with a clear
// error message rather than failing later in a confusing way.

import { logger } from './utils/logger.js';

// A single list pair: the AnyList list name and its matching Skylight list name
export interface ListSyncPair {
  anylistName: string;
  skylightName: string;
}

export interface Config {
  anylist: {
    email: string;
    password: string;
  };
  skylight: {
    email: string;
    password: string;
    frameId: string;
  };
  // Which lists to sync — supports multiple pairs for future expansion
  listSyncPairs: ListSyncPair[];
  syncIntervalMs: number;
  timezone: string;
  logLevel: string;
  stateDbPath: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    // Log clearly and exit — missing config should never cause a silent failure
    logger.error(`Missing required environment variable: ${name}. Check your .env file against .env.example.`);
    process.exit(1);
  }
  return value;
}

function parseListSyncPairs(raw: string): ListSyncPair[] {
  // Format: "AnyList Name=Skylight Name,Another List=Another Skylight List"
  const pairs = raw.split(',').map((pair) => pair.trim()).filter(Boolean);

  if (pairs.length === 0) {
    logger.error('LIST_SYNC_PAIRS is empty. Provide at least one pair, e.g. "Grocery List=Grocery List"');
    process.exit(1);
  }

  return pairs.map((pair) => {
    const equalsIndex = pair.indexOf('=');
    if (equalsIndex === -1) {
      logger.error(`Invalid LIST_SYNC_PAIRS entry: "${pair}". Each entry must be in the format "AnyList Name=Skylight Name"`);
      process.exit(1);
    }
    const anylistName = pair.slice(0, equalsIndex).trim();
    const skylightName = pair.slice(equalsIndex + 1).trim();
    if (!anylistName || !skylightName) {
      logger.error(`Invalid LIST_SYNC_PAIRS entry: "${pair}". Both the AnyList name and Skylight name must be non-empty.`);
      process.exit(1);
    }
    return { anylistName, skylightName };
  });
}

export function loadConfig(): Config {
  const config: Config = {
    anylist: {
      email: requireEnv('ANYLIST_EMAIL'),
      password: requireEnv('ANYLIST_PASSWORD'),
    },
    skylight: {
      email: requireEnv('SKYLIGHT_EMAIL'),
      password: requireEnv('SKYLIGHT_PASSWORD'),
      frameId: requireEnv('SKYLIGHT_FRAME_ID'),
    },
    listSyncPairs: parseListSyncPairs(requireEnv('LIST_SYNC_PAIRS')),
    syncIntervalMs: parseInt(process.env['SYNC_INTERVAL_MS'] ?? '60000', 10),
    timezone: process.env['TIMEZONE'] ?? 'America/New_York',
    logLevel: process.env['LOG_LEVEL'] ?? 'info',
    stateDbPath: process.env['STATE_DB_PATH'] ?? '/data/sync-state.db',
  };

  // Validate that the poll interval is a sensible number
  if (isNaN(config.syncIntervalMs) || config.syncIntervalMs < 10000) {
    logger.error(`SYNC_INTERVAL_MS must be a number >= 10000 (10 seconds). Got: ${process.env['SYNC_INTERVAL_MS']}`);
    process.exit(1);
  }

  logger.info('Configuration loaded', {
    anylistEmail: config.anylist.email,
    skylightEmail: config.skylight.email,
    skylightFrameId: config.skylight.frameId,
    listSyncPairs: config.listSyncPairs,
    syncIntervalMs: config.syncIntervalMs,
    timezone: config.timezone,
    stateDbPath: config.stateDbPath,
  });

  return config;
}
