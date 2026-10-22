export class GatewayError extends Error {
  constructor(readonly code: string, readonly status = 409, options?: ErrorOptions) {
    super(code, options);
    this.name = 'GatewayError';
  }
}
export function requireCondition(condition: unknown, code: string, status = 409): asserts condition {
  if (!condition) throw new GatewayError(code, status);
}
