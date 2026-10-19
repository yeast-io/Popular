import type { Logger } from 'pino';

export type AiLogger = Pick<Logger, 'error'> & Partial<Pick<Logger, 'info' | 'debug' | 'warn'>>;
