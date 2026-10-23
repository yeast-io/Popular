// TEST DOUBLE ONLY. An injected clock makes lease expiry deterministic.
import type { AgentStatus, Route, Router, Session } from '../gateway.types.js';
import { sameSession } from '../gateway.domain.js';

export class MemoryRouter implements Router {
  readonly routes = new Map<string, { route: Route; expiry: number }>();
  readonly handlers = new Set<(id: string) => void>();
  readonly rates = new Map<string, { count: number; until: number }>();

  constructor(readonly now: () => number = Date.now, readonly leaseMs = 45_000) {}

  async claim(session: Session) {
    this.routes.set(session.deviceId, { route: structuredClone(session), expiry: this.now() + this.leaseMs });
  }

  async get(deviceId: string) {
    const old = this.routes.get(deviceId);
    return old && old.expiry > this.now() ? structuredClone(old.route) : null;
  }

  async renew(session: Session, status?: AgentStatus, observedAt = this.now()) {
    const old = this.routes.get(session.deviceId);
    if (!old || old.expiry <= this.now() || !sameSession(old.route, session)) return false;
    if (status) {
      old.route.status = structuredClone(status);
      old.route.statusObservedAt = observedAt;
    }
    old.expiry = this.now() + this.leaseMs;
    return true;
  }

  async release(session: Session) {
    const old = this.routes.get(session.deviceId);
    if (old && sameSession(old.route, session)) this.routes.delete(session.deviceId);
  }

  async wake(deviceId: string) {
    for (const handler of this.handlers) handler(deviceId);
  }

  async subscribe(handler: (deviceId: string) => void) {
    this.handlers.add(handler);
  }

  async rateLimit(key: string, limit: number, windowMs: number) {
    let rate = this.rates.get(key);
    if (!rate || rate.until <= this.now()) {
      rate = { count: 0, until: this.now() + windowMs };
      this.rates.set(key, rate);
    }
    return ++rate.count <= limit;
  }

  async ready() {}

  async close() {}
}
