import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from '../../apps/api/node_modules/dotenv/lib/main.js';
import { createLoggers } from '../../apps/api/src/infrastructure/logging/logger.ts';
import { messages } from './test-email.messages.mjs';

config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

const locale = process.env.MAILGUN_TEST_LOCALE ?? 'zh-CN';
const copy = messages[locale] ?? messages['zh-CN'];
const loggers = createLoggers(process.env.LOG_LEVEL || 'info');
const correlationId = randomUUID();
const startedAt = Date.now();
let stage = 'configuration';

function trace(outcome) {
  if (process.env.VERBOSE === 'true') {
    loggers.app.info({ correlationId, stage, outcome, durationMs: Date.now() - startedAt });
  }
}

try {
  trace('started');
  if (!Object.hasOwn(messages, locale)) throw new Error('MAILGUN_TEST_LOCALE must be zh-CN or en-US');
  if (process.env.VERBOSE && !['true', 'false'].includes(process.env.VERBOSE)) {
    throw new Error('VERBOSE must be true or false');
  }
  const apiKey = process.env.MAILGUN_API_KEY?.trim();
  if (!apiKey) throw new Error('MAILGUN_API_KEY is required');
  const baseUrl = new URL(process.env.MAILGUN_BASE_URL || 'https://api.mailgun.net');
  if (baseUrl.protocol !== 'https:'
    || !['api.mailgun.net', 'api.eu.mailgun.net'].includes(baseUrl.hostname)
    || baseUrl.username || baseUrl.password || baseUrl.port
    || baseUrl.search || baseUrl.hash || !['/', '/v3', '/v3/'].includes(baseUrl.pathname)) {
    throw new Error('MAILGUN_BASE_URL must be an official US or EU Mailgun HTTPS API base URL');
  }
  const domain = 'mail.gofloat.cn';
  const recipient = 'better.sunjian@gmail.com';
  const dryRun = process.argv.includes('--dry-run');
  if (process.argv.slice(2).some((arg) => arg !== '--dry-run')) throw new Error('Only --dry-run is supported');
  trace('validated');

  if (dryRun) {
    console.log(JSON.stringify({ outcome: 'dry_run', locale, domain, recipient, message: copy.dryRun }));
  } else {
    stage = 'mailgun_send';
    trace('started');
    const body = new FormData();
    body.set('from', `Popular <noreply@${domain}>`);
    body.set('to', recipient);
    body.set('subject', copy.subject);
    body.set('text', copy.text);
    body.set('h:X-Correlation-ID', correlationId);
    body.set('o:tracking', 'no');
    const response = await fetch(new URL(`/v3/${domain}/messages`, baseUrl), {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString('base64')}` },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      // Do not log provider response bodies, which may echo request data.
      await response.body?.cancel();
      throw new Error(`Mailgun HTTP ${response.status}`);
    }
    await response.body?.cancel();
    stage = 'complete';
    trace('accepted');
    console.log(JSON.stringify({ correlationId, outcome: 'accepted', domain, recipient, message: copy.accepted }));
  }
} catch (error) {
  loggers.error.error({ correlationId, stage, outcome: 'failed', durationMs: Date.now() - startedAt, err: error }, copy.failed);
  process.exitCode = 1;
}
