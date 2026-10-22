import pino from 'pino';
import { serializeDiagnosticError } from '@movie-hub/contract';

export function scrubGatewayDiagnostic(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/https?:\/\/[^\s"'<>]+/gi, '[REDACTED_URL]');
  if (Array.isArray(value)) return value.map(scrubGatewayDiagnostic);
  if (value && typeof value === 'object') {
    const diagnostic = value as Record<string, unknown>;
    if (diagnostic.type === 'SyntaxError') {
      return {
        ...diagnostic,
        message: 'INVALID_JSON',
        ...(typeof diagnostic.stack === 'string'
          ? { stack: 'SyntaxError: INVALID_JSON\n' + diagnostic.stack.split('\n').slice(1).join('\n') }
          : {}),
        ...(diagnostic.cause ? { cause: scrubGatewayDiagnostic(diagnostic.cause) } : {}),
      };
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubGatewayDiagnostic(v)]));
  }
  return value;
}
export function gatewayLogger(level: string, sensitive: string[] = []) {
  return pino({
    level,
    base: { service: 'popular-helper-gateway' },
    redact: {
      paths: [
        'authorization',
        '*.authorization',
        'apiKey',
        '*.apiKey',
        'keyDigest',
        '*.keyDigest',
        'torrentUrl',
        '*.torrentUrl',
        'url',
        '*.url',
        'req.headers.authorization',
        'cookie',
        '*.cookie',
      ],
      censor: '[REDACTED]',
    },
    serializers: { err: (err: unknown) => scrubGatewayDiagnostic(serializeDiagnosticError(err, sensitive)) },
  });
}
