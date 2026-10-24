import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { configSchema } from './gateway.schema.js';
import { signingIdentity } from './gateway-crypto.service.js';
import { GatewayService } from './gateway.service.js';
import { createGatewayApp } from './gateway.routes.js';
import { createGatewayRedis } from './infrastructure/redis/gateway-redis.service.js';
import { GatewayBridge } from './infrastructure/gateway-bridge.service.js';
import { gatewayLogger } from './gateway-logging.service.js';
import { requireCondition } from './gateway.errors.js';

const config = configSchema.parse(process.env);
const logger = gatewayLogger(config.LOG_LEVEL, [config.INTERNAL_INBOUND_TOKEN, config.REDIS_URL]);
const proxyTls = config.TLS_TERMINATION === 'proxy';
const allowHttp = config.NODE_ENV !== 'production' && config.ALLOW_INSECURE_DEV;
requireCondition(proxyTls || (config.TLS_CERT_FILE && config.TLS_KEY_FILE) || allowHttp, 'HTTPS_REQUIRED', 500);
const instanceId = randomUUID();
const redis = createGatewayRedis({
  url: config.REDIS_URL,
  instanceId,
  token: config.INTERNAL_INBOUND_TOKEN,
  logger,
});
const { router, bus } = redis;
const bridge = new GatewayBridge(bus);
let app: Awaited<ReturnType<typeof createGatewayApp>> | undefined;
try {
  await router.ready();
  const service = new GatewayService({
    instanceId,
    router,
    bus,
    popular: bridge,
    signing: await signingIdentity(
      config.SIGNING_KEY_ID,
      JSON.parse(await readFile(config.SIGNING_PRIVATE_KEY_FILE, 'utf8'))
    ),
    logger,
    verbose: config.VERBOSE,
  });
  await bus.start((kind, frame) => {
    return kind === 'popular' ? bridge.relay(frame) : service.handleRpc(frame.command, frame.payload, frame);
  });
  app = await createGatewayApp(service, config.INTERNAL_INBOUND_TOKEN, {
    bridge,
    ...(!proxyTls && config.TLS_CERT_FILE && config.TLS_KEY_FILE
      ? {
          tls: {
            cert: await readFile(config.TLS_CERT_FILE),
            key: await readFile(config.TLS_KEY_FILE),
          },
        }
      : {
          tlsTerminatedByProxy: proxyTls,
          allowInsecureDev: allowHttp,
          ...(proxyTls ? { trustProxy: 'loopback' as const } : {}),
        }),
  });
  await app.listen({ host: config.HOST, port: config.PORT });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 10_000);
    deadline.unref();
    try {
      try {
        await app?.close();
      } finally {
        try {
          await bridge.close();
        } finally {
          await redis.close();
        }
      }
    } catch (err) {
      logger.error({ err, stage: 'shutdown' }, 'gateway');
      process.exitCode = 1;
    } finally {
      clearTimeout(deadline);
    }
  };
  process.once('SIGTERM', () => {
    void stop();
  });
  process.once('SIGINT', () => {
    void stop();
  });
} catch (err) {
  logger.error({ err, stage: 'startup' }, 'gateway');
  process.exitCode = 1;
  try {
    await app?.close();
  } finally {
    try {
      await bridge.close();
    } finally {
      await redis.close();
    }
  }
}
