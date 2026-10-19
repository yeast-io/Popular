// Extract metadata explicitly; error messages and database error values can contain secrets.
export function streamErrorDiagnostics(error: unknown) {
  const causes: Array<{ errorType: string; locations: string[]; databaseCode?: number; validationFields?: string[] }> =
    [];
  const types = new Set([
    'Error',
    'TypeError',
    'ReferenceError',
    'RangeError',
    'SyntaxError',
    'AppError',
    'LlmProviderError',
    'ValidationError',
    'CastError',
    'MongoServerError',
    'MongoNetworkError',
    'MongoServerSelectionError',
    'MongooseError',
    'AbortError',
  ]);
  const fields = new Set([
    'ownerId',
    'threadId',
    'sequence',
    'role',
    'content',
    'clientRequestId',
    'inputTokens',
    'outputTokens',
  ]);
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const locations = (current.stack ?? '')
      .split('\n')
      .slice(1)
      .filter((line) => /^\s+at /.test(line))
      .flatMap((line) => {
        return [...line.matchAll(/(?:file:\/\/)?(\/[A-Za-z0-9_./@%+~-]+\.(?:[cm]?js|tsx?):\d+:\d+)/g)].map(
          (match) => match[1]!,
        );
      })
      .slice(0, 5);
    const metadata = current as Error & { code?: unknown; errors?: unknown };
    causes.push({
      errorType: types.has(current.name) ? current.name : 'Error',
      locations,
      ...(typeof metadata.code === 'number' && Number.isSafeInteger(metadata.code)
        ? { databaseCode: metadata.code }
        : {}),
      ...(current.name === 'ValidationError' && metadata.errors && typeof metadata.errors === 'object'
        ? { validationFields: Object.keys(metadata.errors).filter((key) => fields.has(key)) }
        : {}),
    });
    current = current.cause;
  }
  return { causes };
}
