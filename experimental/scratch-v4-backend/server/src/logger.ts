/**
 * Minimal WSLogger stub matching the server's interface.
 * The experimental backend uses console-based logging; swap for the real
 * implementation (server/src/logger.ts) if/when this is folded back in.
 */

type Fields = { source: string; message: string; [key: string]: unknown };

export class WSLogger {
  static info(fields: Fields): void {
    console.log(`[INFO] [${fields.source}] ${fields.message}`, omit(fields, 'source', 'message'));
  }
  static warn(fields: Fields): void {
    console.warn(`[WARN] [${fields.source}] ${fields.message}`, omit(fields, 'source', 'message'));
  }
  static error(fields: Fields): void {
    console.error(`[ERROR] [${fields.source}] ${fields.message}`, omit(fields, 'source', 'message'));
  }
  static debug(fields: Fields): void {
    if (process.env.NODE_ENV === 'development') {
      console.debug(`[DEBUG] [${fields.source}] ${fields.message}`, omit(fields, 'source', 'message'));
    }
  }
  static http(fields: Fields): void {
    WSLogger.debug(fields);
  }
}

function omit(obj: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!keys.includes(k)) result[k] = v;
  }
  return result;
}
