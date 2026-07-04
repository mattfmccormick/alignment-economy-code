// Structured logger. Emits one JSON object per line: { time, level, tag, msg,
// ...bound fields, ...event fields }. JSON keeps logs machine-parseable in
// production; pipe through a pretty-printer locally if you want.
//
// The call shape is unchanged from the original console logger
// (`logger.info(tag, msg, data?)`), so existing callers keep working. `data`
// is merged into the record when it's a plain object, serialized under `err`
// when it's an Error, and placed under `data` otherwise. `logger.child(fields)`
// returns a logger that stamps those fields on every line (used to bind a
// requestId per HTTP request).

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

function envLevel(): Level {
  const v = process.env.LOG_LEVEL;
  return v && v in LEVELS ? (v as Level) : 'info';
}

let currentLevel: Level = envLevel();

export function setLogLevel(level: Level): void {
  currentLevel = level;
}

type Fields = Record<string, unknown>;

function emit(level: Level, tag: string, msg: string, bound: Fields, data?: unknown): void {
  if (LEVELS[level] < LEVELS[currentLevel]) return;

  const record: Fields = { time: new Date().toISOString(), level, tag, msg, ...bound };

  if (data !== undefined) {
    if (data instanceof Error) {
      record.err = { name: data.name, message: data.message, stack: data.stack };
    } else if (typeof data === 'object' && data !== null) {
      Object.assign(record, data);
    } else {
      record.data = data;
    }
  }

  const line = JSON.stringify(record);
  if (level === 'error') console.error(line);
  else console.log(line);
}

function make(bound: Fields) {
  return {
    debug: (tag: string, msg: string, data?: unknown) => emit('debug', tag, msg, bound, data),
    info: (tag: string, msg: string, data?: unknown) => emit('info', tag, msg, bound, data),
    warn: (tag: string, msg: string, data?: unknown) => emit('warn', tag, msg, bound, data),
    error: (tag: string, msg: string, data?: unknown) => emit('error', tag, msg, bound, data),
    child: (fields: Fields) => make({ ...bound, ...fields }),
  };
}

export type Logger = ReturnType<typeof make>;

export const logger: Logger = make({});
