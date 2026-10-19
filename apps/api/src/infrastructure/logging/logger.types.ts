import type { Logger } from 'pino';

export interface AppLoggers {
  app: Logger;
  error: Logger;
}
