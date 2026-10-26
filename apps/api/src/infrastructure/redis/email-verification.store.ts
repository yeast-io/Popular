import type { Redis } from 'ioredis';
import type { EmailVerificationStore, PendingRegistration, VerificationReservation } from '../../modules/auth/email-verification.types.js';
import { emailVerificationPolicy as policy } from '../../modules/auth/email-verification.policy.js';

const reserveScript = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if redis.call('EXISTS', KEYS[1]) == 1 then
  return {'existing', tostring(now + redis.call('PTTL', KEYS[1]))}
end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - tonumber(ARGV[4]) * 1000)
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[5]) then return {'limit', '0'} end
redis.call('ZADD', KEYS[2], now, ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[4])
redis.call('HSET', KEYS[1], 'payload', ARGV[1], 'digest', ARGV[2], 'reservation', ARGV[3], 'attempts', '0')
redis.call('EXPIRE', KEYS[1], ARGV[4])
return {'created', tostring(now + tonumber(ARGV[4]) * 1000)}
`;

const claimScript = `
if redis.call('EXISTS', KEYS[1]) == 0 then return nil end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if tonumber(redis.call('HGET', KEYS[1], 'claimUntil') or '0') > now then return nil end
if tonumber(redis.call('HGET', KEYS[1], 'attempts')) >= tonumber(ARGV[3]) then return nil end
if redis.call('HGET', KEYS[1], 'digest') ~= ARGV[1] then
  redis.call('HINCRBY', KEYS[1], 'attempts', 1)
  return nil
end
redis.call('HSET', KEYS[1], 'claim', ARGV[2], 'claimUntil', now + tonumber(ARGV[4]) * 1000)
return redis.call('HGET', KEYS[1], 'payload')
`;

const finishScript = `
if redis.call('HGET', KEYS[1], 'claim') ~= ARGV[1] then return 0 end
if ARGV[2] == '1' then return redis.call('DEL', KEYS[1]) end
return redis.call('HDEL', KEYS[1], 'claim', 'claimUntil')
`;

const cancelScript = `
if redis.call('HGET', KEYS[1], 'reservation') == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

export class RedisEmailVerificationStore implements EmailVerificationStore {
  constructor(private readonly redis: Redis) {}

  async reserve(emailKey: string, codeDigest: string, reservationId: string, registration: PendingRegistration): Promise<VerificationReservation> {
    const result = await this.redis.eval(reserveScript, 2, this.key(emailKey), 'registration:email:quota',
      JSON.stringify(registration), codeDigest, reservationId, policy.ttlSeconds, policy.dailyLimit) as [VerificationReservation['status'], string];
    return { status: result[0], expiresAt: Number(result[1]) };
  }

  async claim(emailKey: string, codeDigest: string, claimId: string): Promise<PendingRegistration | null> {
    const result = await this.redis.eval(claimScript, 1, this.key(emailKey), codeDigest, claimId, policy.maxAttempts, policy.claimSeconds);
    return typeof result === 'string' ? JSON.parse(result) as PendingRegistration : null;
  }

  async finish(emailKey: string, claimId: string, remove: boolean): Promise<void> {
    await this.redis.eval(finishScript, 1, this.key(emailKey), claimId, remove ? '1' : '0');
  }

  async cancel(emailKey: string, reservationId: string): Promise<void> {
    // Keep the quota slot: a timed-out HTTP request may still have sent an email.
    await this.redis.eval(cancelScript, 1, this.key(emailKey), reservationId);
  }

  private key(emailKey: string): string {
    return `registration:email:pending:${emailKey}`;
  }
}
