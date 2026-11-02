import assert from 'node:assert/strict';
import test from 'node:test';
import { TelegramClient } from './client.js';
import { telegramNetworkDiagnostics } from './telegram-network.client.js';

const token = '123456789:private-bot-credential';
test('typing uses sendChatAction with the chat and propagates cancellation', async () => {
  const controller = new AbortController();
  const client = new TelegramClient(token, (async (url, options) => {
    assert.ok(String(url).endsWith('/sendChatAction'));
    assert.deepEqual(JSON.parse(String(options?.body)), { chat_id: '101', action: 'typing' });
    assert.equal(options?.signal?.aborted, false);
    controller.abort();
    assert.equal(options?.signal?.aborted, true);
    throw controller.signal.reason;
  }) as typeof fetch);
  await assert.rejects(client.typing('101', controller.signal), { name: 'AbortError' });
});
function logFixture() {
  const logs: Array<Record<string, unknown>> = [];
  const logger = {
    info: (fields: Record<string, unknown>) => {
      logs.push(fields);
    },
    error: (fields: Record<string, unknown>) => {
      logs.push(fields);
    },
  };
  return { logs, logger };
}

test('HTTP diagnostics expose conflict status and API code without token or response body', async () => {
  const { logs, logger } = logFixture();
  const client = new TelegramClient(
    token,
    (async () => {
      return new Response(JSON.stringify({ ok: false, error_code: 409, description: 'private upstream description' }), {
        status: 409,
      });
    }) as typeof fetch,
    logger
  );
  await assert.rejects(client.updates(123), { code: 'SERVICE_UNAVAILABLE' });
  assert.ok(
    logs.some((line) => {
      return line.httpStatus === 409 && line.telegramErrorCode === 409 && line.method === 'getUpdates';
    })
  );
  assert.ok(!JSON.stringify(logs).includes(token));
  assert.ok(!JSON.stringify(logs).includes('private upstream description'));
});

test('HTTP diagnostics preserve network causes while redacting token, URL credentials and message text', async () => {
  const { logs, logger } = logFixture();
  const text = 'private outgoing message';
  const fetcher = (async () => {
    throw new Error(`fetch https://api.telegram.org/bot${token}/sendMessage failed: ${text}`, {
      cause: Object.assign(new Error('proxy http://user:proxy-password@proxy.example refused'), {
        code: 'ECONNREFUSED',
      }
      ),
    });
  }) as typeof fetch;
  const client = new TelegramClient(token, fetcher, logger);
  await assert.rejects(client.send('101', text), (error: unknown) => {
    assert.ok(error instanceof Error);
    const serialized = JSON.stringify(error.cause);
    assert.match(serialized, /ECONNREFUSED/);
    assert.match(serialized, /stack/);
    for (const secret of [token, text, 'proxy-password']) assert.ok(!serialized.includes(secret));
    return true;
  });
  const output = JSON.stringify(logs);
  assert.match(output, /ECONNREFUSED/);
  assert.match(output, /stack/);
  for (const secret of [token, text, 'proxy-password']) assert.ok(!output.includes(secret));
});

test('routine HTTP logs require verbose and polling additionally requires the poll switch', async () => {
  for (const verbose of [false, true]) {
    for (const enabled of [false, true]) {
      const { logs, logger } = logFixture();
      const client = new TelegramClient(
        token,
        (async () => {
          return new Response(JSON.stringify({ ok: true, result: [] }));
        }) as typeof fetch,
        logger,
        enabled,
        verbose
      );
      await client.updates(0);
      assert.equal(
        logs.some((line) => line.method === 'getUpdates'),
        verbose && enabled
      );
      const sender = new TelegramClient(
        token,
        (async () => {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
        }) as typeof fetch,
        logger,
        enabled,
        verbose
      );
      await sender.send('101', 'private reply');
      assert.equal(logs.some((line) => line.method === 'sendMessage'), verbose);
    }
  }
});

test('proxy diagnostics expose endpoints and switches without credentials, paths or bypass lists', () => {
  const network = telegramNetworkDiagnostics({
    HTTPS_PROXY: 'http://private-user:private-password@127.0.0.1:7890/private-path?token=private-token',
    ALL_PROXY: 'invalid-private-value',
    NO_PROXY: 'private.internal',
    NODE_USE_ENV_PROXY: '1',
  });
  assert.deepEqual(network.proxyEnvironment.HTTPS_PROXY, {
    configured: true,
    protocol: 'http:',
    hostname: '127.0.0.1',
    port: '7890',
    authenticationConfigured: true,
  });
  assert.deepEqual(network.proxyEnvironment.ALL_PROXY, { configured: true, invalidUrl: true });
  assert.equal(network.nodeUseEnvProxy, true);
  assert.equal(network.noProxyConfigured, true);
  assert.equal(network.proxyRoute, 'unverified');
  assert.ok(!JSON.stringify(network).includes('private-'));
  assert.ok(!JSON.stringify(network).includes('private.internal'));
});

test('poll failures retain network diagnostics even with routine polling logs disabled', async () => {
  for (const verbose of [false, true]) {
    const { logs, logger } = logFixture();
    const client = new TelegramClient(token, (async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect timeout'), {
        code: 'UND_ERR_CONNECT_TIMEOUT',
      }) });
    }) as typeof fetch, logger, false, verbose);
    await assert.rejects(client.updates(0));
    const failure = logs.find((line) => line.event === 'telegram_http_failed');
    assert.ok(failure);
    assert.equal(failure.failureStage, 'fetch');
    assert.equal(Boolean(failure.network), verbose);
    assert.match(JSON.stringify(failure), /UND_ERR_CONNECT_TIMEOUT/);
  }
});
