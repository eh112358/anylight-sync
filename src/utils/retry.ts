// Retry helper for HTTP calls and other operations that may fail transiently.
// Uses exponential backoff: each attempt waits twice as long as the previous one.
// Example: attempt 1 waits 1s, attempt 2 waits 2s, attempt 3 waits 4s, etc.

import { logger } from './logger.js';

interface RetryOptions {
  // Maximum number of attempts (including the first try)
  maxAttempts: number;
  // How long to wait before the first retry, in milliseconds
  initialDelayMs: number;
  // Optional label shown in log messages so you know which operation is retrying
  operationName?: string;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  initialDelayMs: 1000,
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const name = config.operationName ?? 'operation';
  let delayMs = config.initialDelayMs;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const isLastAttempt = attempt === config.maxAttempts;

      if (isLastAttempt) {
        logger.error(`${name} failed after ${config.maxAttempts} attempts`, {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      logger.warn(`${name} failed on attempt ${attempt}, retrying in ${delayMs}ms`, {
        error: error instanceof Error ? error.message : String(error),
        attemptsRemaining: config.maxAttempts - attempt,
      });

      await wait(delayMs);
      delayMs *= 2; // exponential backoff
    }
  }

  // TypeScript requires this even though the loop above always returns or throws
  throw new Error(`${name} exceeded max attempts`);
}
