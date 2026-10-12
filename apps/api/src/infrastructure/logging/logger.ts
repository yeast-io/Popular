import pino, { type Logger } from 'pino';

const redactPaths = [
  'password',
  '*.password',
  'apiKey',
  '*.apiKey',
  'encryptedApiKey',
  '*.encryptedApiKey',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.body.apiKey',
  'headers["x-api-key"]',
  'body.apiKey',
  'authorization',
  'cookie',
  'sessionToken',
  'tmdbToken',
  'accessKey',
  'secretKey',
];

export interface AppLoggers {
  app: Logger;
  error: Logger;
}

export function createLoggers(level: string): AppLoggers {
  const base = { service: 'movie-hub-api' };
  const options = {
    level,
    base,
    redact: { paths: redactPaths, censor: '[REDACTED]' },
    serializers: { err: serializeError },
  } as const;
  return {
    app: pino(options, pino.destination(1)),
    error: pino(options, pino.destination(2)),
  };
}

export function createPrettyLoggers() {
  const logger = pino({
    transport: {
      target: 'pino-pretty'
    },
  });
  return logger;
}

function serializeError(error: Error) {
  return {
    type: error.name,
    message: redactText(error.message),
    stack: redactText(error.stack ?? ''),
  };
}

function redactText(value: string): string {
  return value
    .replace(/((?:mongodb(?:\+srv)?|rediss?):\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:X-Amz-Signature|X-Amz-Credential|token|access_token)=)[^&\s]+/gi, '$1[REDACTED]');
}
