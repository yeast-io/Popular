export function redactDiagnosticText(text: string, sensitiveValues: readonly string[] = []): string {
  let safe = text;
  for (const value of [...sensitiveValues].filter(Boolean).sort((a, b) => b.length - a.length)) {
    safe = safe.split(value).join('[REDACTED]');
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value) safe = safe.split(escaped).join('[REDACTED]');
  }
  return safe
    .replace(/(api\.telegram\.org\/bot)[^/\s]+/gi, '$1[REDACTED]')
    .replace(/\b\d{5,}:[a-zA-Z0-9_-]{15,}\b/g, '[REDACTED]')
    .replace(/\bsk-[a-zA-Z0-9_-]+/g, '[REDACTED]')
    .replace(/(Bearer\s+)[^\s"',}]+/gi, '$1[REDACTED]')
    .replace(/((?:mongodb(?:\+srv)?|rediss?|https?):\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:X-Amz-Signature|X-Amz-Credential|token|access_token|api_key)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/((?:apiKey|api_key|password|authorization|cookie|secretKey|accessToken)["']?\s*[:=]\s*)[^\r\n,}]+/gi, '$1[REDACTED]')
    .replace(/(dup key:\s*)\{[^\r\n]*\}/gi, '$1[REDACTED]')
    .replace(/(value\s+)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi, '$1[REDACTED]');
}

export function serializeDiagnosticError(error: unknown, sensitiveValues: readonly string[] = [], seen = new Set<unknown>(), depth = 0): Record<string, unknown> {
  if (depth >= 8 || seen.has(error)) return { type: 'TruncatedCause', message: 'Circular or deep error cause' };
  if (typeof error !== 'object' || error === null) {
    return { type: 'NonError', message: redactDiagnosticText(String(error), sensitiveValues) };
  }
  seen.add(error);
  const source = error as Record<string, unknown>;
  const text = (value: unknown) => redactDiagnosticText(String(value), sensitiveValues);
  const result: Record<string, unknown> = {
    type: text(source.name ?? 'Error'), message: text(source.message ?? 'Unknown error'),
    ...(typeof source.stack === 'string' ? { stack: text(source.stack) } : {}),
  };
  for (const key of ['code', 'status', 'statusCode', 'request_id', 'errno', 'syscall'] as const) {
    if (typeof source[key] === 'string' || typeof source[key] === 'number') result[key] = typeof source[key] === 'number' ? source[key] : text(source[key]);
  }
  if (source.keyPattern && typeof source.keyPattern === 'object') result.indexFields = Object.keys(source.keyPattern).map(text);
  if (source.errors && typeof source.errors === 'object') {
    result.validationErrors = Object.entries(source.errors).map(([field, value]) => ({
      field: text(field), error: serializeDiagnosticError(value, sensitiveValues, seen, depth + 1),
    }));
  }
  if (source.cause !== undefined) result.cause = serializeDiagnosticError(source.cause, sensitiveValues, seen, depth + 1);
  // SDK response headers, request bodies, keyValue, and raw provider objects are deliberately excluded.
  return result;
}
