const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;

let currentLevel: keyof typeof LEVELS = 'info';

export function setLogLevel(level: keyof typeof LEVELS): void {
  currentLevel = level;
}

function timestamp(): string {
  return new Date().toISOString();
}

function log(level: keyof typeof LEVELS, tag: string, msg: string, data?: unknown): void {
  if (LEVELS[level] < LEVELS[currentLevel]) return;
  const prefix = `[${timestamp()}] [${level.toUpperCase()}] [${tag}]`;
  if (data !== undefined) {
    console.log(`${prefix} ${msg}`, data);
  } else {
    console.log(`${prefix} ${msg}`);
  }
}

export const logger = {
  debug: (tag: string, msg: string, data?: unknown) => log('debug', tag, msg, data),
  info: (tag: string, msg: string, data?: unknown) => log('info', tag, msg, data),
  warn: (tag: string, msg: string, data?: unknown) => log('warn', tag, msg, data),
  error: (tag: string, msg: string, data?: unknown) => log('error', tag, msg, data),
};
