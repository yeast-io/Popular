import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { configSchema } from './gateway.schema.js';
import { signingIdentity } from './gateway-crypto.service.js';
import { GatewayService } from './gateway.service.js';
import { createGatewayApp } from './gateway.routes.js';
import { createRedisClient } from './infrastructure/redis/client.js';
import { GatewayBridge } from './infrastructure/gateway-bridge.service.js';
import { gatewayLogger } from './gateway-logging.service.js';

const config = configSchema.parse(process.env);
const logger = gatewayLogger(config.LOG_LEVEL, [config.INTERNAL_INBOUND_TOKEN, config.REDIS_URL]);
const instanceId = randomUUID();
const redisClient = createRedisClient({
  url: config.REDIS_URL,
  instanceId,
  token: config.INTERNAL_INBOUND_TOKEN,
  logger,
});
const { coordinator: gatewayCoordinator, bus } = redisClient;
const bridge = new GatewayBridge(bus);
let app: Awaited<ReturnType<typeof createGatewayApp>> | undefined;
try {
  await gatewayCoordinator.ready();
  const service = new GatewayService({
    instanceId,
    gatewayCoordinator,
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
    trustProxy: 'loopback',
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
          await redisClient.close();
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
      await redisClient.close();
    }
  }
}
