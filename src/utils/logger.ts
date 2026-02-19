// Simple structured logger that writes to stdout.
// Log level is controlled by the LOG_LEVEL environment variable.
// All log lines are prefixed with an ISO timestamp and level label.

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function currentLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  if (raw in LEVELS) return raw as LogLevel;
  return 'info';
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[currentLevel()];
}

function format(level: LogLevel, message: string, context?: Record<string, unknown>): string {
  const timestamp = new Date().toISOString();
  const contextStr = context ? ' ' + JSON.stringify(context) : '';
  return `${timestamp} [${level.toUpperCase()}] ${message}${contextStr}`;
}

export const logger = {
  debug(message: string, context?: Record<string, unknown>): void {
    if (shouldLog('debug')) console.debug(format('debug', message, context));
  },
  info(message: string, context?: Record<string, unknown>): void {
    if (shouldLog('info')) console.info(format('info', message, context));
  },
  warn(message: string, context?: Record<string, unknown>): void {
    if (shouldLog('warn')) console.warn(format('warn', message, context));
  },
  error(message: string, context?: Record<string, unknown>): void {
    if (shouldLog('error')) console.error(format('error', message, context));
  },
};
