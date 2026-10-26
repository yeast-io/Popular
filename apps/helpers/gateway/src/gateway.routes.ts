import Fastify, { LogController } from 'fastify';
import websocket from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { Value } from '@sinclair/typebox/value';
import { ServiceHelloSchema, GatewayRpcSchemas } from '@movie-hub/contract';
import { SocketRpc, RpcError } from '@movie-hub/contract/socket-rpc';
import type { GatewayBridge } from './infrastructure/gateway-bridge.service.js';
import type { ServicePeer } from './gateway.types.js';
import { GatewayError, requireCondition } from './gateway.errors.js';
import { equalSecret, keyDigest, message } from './gateway.domain.js';
import type { Peer, WireMessage } from './gateway.types.js';
import type { GatewayService } from './gateway.service.js';

export async function createGatewayApp(
  service: GatewayService,
  internalToken: string,
  options: {
    bridge?: GatewayBridge;
    trustProxy?: 'loopback';
  } = {}
) {
  const app = Fastify({
    trustProxy: options.trustProxy ?? false,
    bodyLimit: 65_536,
    requestTimeout: 15_000,
    connectionTimeout: 15_000,
    loggerInstance: service.options.logger,
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: (request) => {
      const id = request.headers['x-correlation-id'];
      return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(id) ? id : randomUUID();
    },
  });
  const pending = new Set<Peer>();
  const work = new Set<Promise<void>>();
  let stopping = false;
  const bearer = (header: string | undefined) => {
    requireCondition(header && header.startsWith('Bearer ') && header.length <= 4096, 'AUTHENTICATION_REQUIRED', 401);
    return header.slice(7);
  };
  app.setErrorHandler((err, request, reply) => {
    const frameworkStatus
      = err instanceof Error
        && 'statusCode' in err
        && typeof err.statusCode === 'number'
        && [400, 413, 415, 429].includes(err.statusCode)
        ? err.statusCode
        : undefined;
    const code
      = err instanceof RpcError
        ? err.code
        : err instanceof GatewayError
          ? err.code
          : err instanceof ZodError || frameworkStatus
            ? 'INVALID_REQUEST'
            : 'INTERNAL_ERROR';
    const status
      = err instanceof RpcError
        ? err.code === 'INVALID_API_KEY'
          ? 401
          : 503
        : err instanceof GatewayError
          ? err.status
          : err instanceof ZodError
            ? 400
            : (frameworkStatus ?? 500);
    if (status >= 500)
      service.options.logger.error({ err, stage: 'http.failure', correlationId: request.id }, 'gateway');
    void reply.code(status).send({ error: { code, correlationId: request.id } });
  });
  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send({ error: { code: 'ROUTE_NOT_FOUND', correlationId: request.id } });
  });
  app.addHook('onRequest', async (request) => {
    if (service.options.verbose)
      request.log.info(
        { stage: 'http.entry', correlationId: request.id, method: request.method, route: request.routeOptions.url },
        'gateway'
      );
  });
  app.addHook('onResponse', async (request, reply) => {
    if (service.options.verbose)
      request.log.info(
        { stage: 'http.complete', correlationId: request.id, outcome: reply.statusCode, durationMs: reply.elapsedTime },
        'gateway'
      );
  });
  await app.register(websocket, { options: { maxPayload: 65_536, perMessageDeflate: false } });
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async () => {
    await Promise.all([options.bridge?.ready(), service.options.gatewayCoordinator.ready()]);
    return { status: 'ok' };
  });
  app.get('/client/v1/signing-keys', async (request) => {
    requireCondition(
      await service.options.gatewayCoordinator.rateLimit(`keys:${keyDigest(request.ip ?? 'unknown')}`, 120, 60_000),
      'RATE_LIMITED',
      429
    );
    return service.signingKeys(bearer(request.headers.authorization), request.id);
  });
  const serviceSockets = new Set<SocketRpc>();
  app.get(
    '/service/v1/socket',
    {
      websocket: true,
      preValidation: async (request) => {
        requireCondition(!request.url.includes('?'), 'SOCKET_QUERY_NOT_ALLOWED', 400);
        requireCondition(
          equalSecret(bearer(request.headers.authorization), internalToken),
          'INVALID_SERVICE_CREDENTIAL',
          401
        );
        requireCondition(options.bridge, 'SERVICE_BRIDGE_REQUIRED', 503);
      },
    },
    (socket, request) => {
      const connectionId = randomUUID();
      const connectedAt = Date.now();
      let popularInstanceId: string | undefined;
      let poolSlotId: string | undefined;
      service.options.logger.info(
        {
          stage: 'socket.connected',
          clientType: 'popular',
          connectionId,
          correlationId: request.id,
          gatewayInstanceId: service.options.instanceId,
          remoteAddress: request.ip,
          outcome: 'connected',
        },
        'gateway'
      );
      let peer: ServicePeer | undefined;
      let announced = false;
      let alive = true;
      const deadline = setTimeout(() => {
        if (!announced) socket.terminate();
      }, 10_000);
      const ping = setInterval(() => {
        if (!alive) socket.terminate();
        else {
          alive = false;
          socket.ping();
        }
      }, 15_000);
      socket.on('pong', () => {
        alive = true;
      });
      const rpc = new SocketRpc({
        transport: {
          send: (text) =>
            socket.send(text, (error) => {
              if (error) socket.terminate();
            }),
          close: () => socket.terminate(),
          open: () => socket.readyState === socket.OPEN,
          bufferedBytes: () => socket.bufferedAmount,
          onMessage: (handler) => {
            return socket.on('message', (data, binary) => {
              if (binary) socket.terminate();
              else handler(data.toString());
            });
          },
          onClose: (handler) => socket.once('close', handler),
        },
        allowed: ['__service_hello__', ...Object.keys(GatewayRpcSchemas)],
        diagnostics: {
          verbose: service.options.verbose,
          info: (fields) => service.options.logger.info(fields, 'gateway'),
          error: (err, fields) => service.options.logger.error({ err, ...fields }, 'gateway'),
        },
        handle: async (command, payload, frame) => {
          if (command === '__service_hello__') {
            requireCondition(Value.Check(ServiceHelloSchema, payload), 'INVALID_REQUEST', 400);
            const firstHello = !announced;
            if (firstHello) {
              announced = true;
              peer = await options.bridge!.add(rpc);
              popularInstanceId = payload.popularInstanceId;
              poolSlotId = payload.poolSlotId;
            }
            if (socket.readyState !== socket.OPEN) {
              if (peer) await options.bridge!.remove(peer);
              throw new RpcError('RPC_CONNECTION_CLOSED');
            }
            if (firstHello) {
              service.options.logger.info(
                {
                  stage: 'socket.authenticated',
                  clientType: 'popular',
                  connectionId,
                  correlationId: frame.correlationId,
                  gatewayInstanceId: service.options.instanceId,
                  popularInstanceId,
                  poolSlotId,
                  durationMs: Date.now() - connectedAt,
                  outcome: 'ready',
                },
                'gateway'
              );
            }
            return { gatewayInstanceId: service.options.instanceId, connectionId, serverTime: Date.now() };
          }
          requireCondition(announced, 'SERVICE_HELLO_REQUIRED', 401);
          try {
            return await service.handleRpc(command, payload, frame);
          } catch (error) {
            if (error instanceof GatewayError) throw new RpcError(error.code, 'not_applied', { cause: error });
            throw error;
          }
        },
      });
      serviceSockets.add(rpc);
      socket.on('error', (err) => {
        service.options.logger.error({ err, stage: 'service-socket.transport' }, 'gateway');
        socket.terminate();
      });
      socket.once('close', (code) => {
        service.options.logger.info(
          {
            stage: 'socket.disconnected',
            clientType: 'popular',
            connectionId,
            correlationId: request.id,
            gatewayInstanceId: service.options.instanceId,
            popularInstanceId,
            poolSlotId,
            closeCode: code,
            durationMs: Date.now() - connectedAt,
            outcome: 'disconnected',
          },
          'gateway'
        );
        clearTimeout(deadline);
        clearInterval(ping);
        serviceSockets.delete(rpc);
        if (peer)
          void options
            .bridge!.remove(peer)
            .catch(
              (err) => service.options.logger.error({ err, stage: 'service-socket.close' }, 'gateway')
            );
      });
    });
  app.get(
    '/client/v1/socket',
    {
      websocket: true,
      preValidation: async (request) => {
        requireCondition(!request.url.includes('?'), 'SOCKET_QUERY_NOT_ALLOWED', 400);
        requireCondition(
          await service.options.gatewayCoordinator.rateLimit(`auth:${keyDigest(request.ip ?? 'unknown')}`, 30, 60_000),
          'RATE_LIMITED',
          429
        );
        await service.keyAuthorization(keyDigest(bearer(request.headers.authorization)), undefined, request.id);
      },
    },
    (socket, request) => {
      const connectedAt = Date.now();
      let queued = 0;
      let chain = Promise.resolve();
      let alive = true;
      let closed = false;
      const peer: Peer = {
        id: randomUUID(),
        digest: keyDigest(bearer(request.headers.authorization)),
        send(wire: WireMessage) {
          requireCondition(
            socket.readyState === socket.OPEN && socket.bufferedAmount <= 1_048_576,
            'SOCKET_BACKPRESSURE',
            503
          );
          socket.send(JSON.stringify(wire), (err) => {
            if (err) {
              service.options.logger.error({ err, stage: 'socket.send', correlationId: wire.correlationId }, 'gateway');
              socket.terminate();
            }
          });
        },
        close(code) {
          socket.close(code);
          const deadline = setTimeout(() => socket.terminate(), 2000);
          deadline.unref();
          socket.once('close', () => clearTimeout(deadline));
        },
      };
      service.options.logger.info(
        {
          stage: 'socket.connected',
          clientType: 'agent',
          connectionId: peer.id,
          correlationId: request.id,
          gatewayInstanceId: service.options.instanceId,
          remoteAddress: request.ip,
          outcome: 'connected',
        },
        'gateway'
      );
      pending.add(peer);
      const authTimeout = setTimeout(() => {
        if (!peer.session) socket.terminate();
      }, 10_000);
      const ping = setInterval(() => {
        if (!alive) {
          socket.terminate();
          return;
        }
        alive = false;
        socket.ping();
      }, 15_000
      );
      socket.on('pong', () => {
        alive = true;
      });
      socket.on('message', (data, isBinary) => {
        if (closed || stopping) return;
        if (isBinary || queued >= 32) {
          socket.close(1008);
          return;
        }
        queued++;
        // Install synchronously. Serialize each connection, bounding its queued work.
        chain = chain
          .then(async () => {
            if (closed) return;
            requireCondition(
              await service.options.gatewayCoordinator.rateLimit(`messages:${peer.id}`, 120, 1000),
              'RATE_LIMITED',
              429
            );
            await service.message(peer, JSON.parse(data.toString()));
          })
          .catch(async (err) => {
            const code
              = err instanceof RpcError
                ? err.code
                : err instanceof GatewayError
                  ? err.code
                  : err instanceof ZodError || err instanceof SyntaxError
                    ? 'INVALID_MESSAGE'
                    : 'INTERNAL_ERROR';
            if (!(err instanceof GatewayError) && !(err instanceof ZodError) && !(err instanceof SyntaxError)) {
              service.options.logger.error({ err, stage: 'socket.message', connectionId: peer.id }, 'gateway');
            }
            try {
              peer.send(message('__error__', { code }));
            } catch {
              socket.terminate();
            }
            if (!peer.session || code === 'SESSION_REVOKED') socket.close(4001);
          })
          .finally(() => {
            queued--;
          });
        const active = chain;
        work.add(active);
        void active.then(
          () => work.delete(active),
          () => work.delete(active)
        );
      });
      const clean = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        clearTimeout(authTimeout);
        pending.delete(peer);
        // Also clean again after any in-flight auth finishes: close during Mongo/Redis I/O must not leak a lease.
        void chain
          .finally(() => service.dropped(peer))
          .catch((err) => {
            service.options.logger.error({ err, stage: 'socket.cleanup', connectionId: peer.id }, 'gateway');
          });
      };
      socket.once('close', (code) => {
        service.options.logger.info(
          {
            stage: 'socket.disconnected',
            clientType: 'agent',
            connectionId: peer.id,
            correlationId: request.id,
            gatewayInstanceId: service.options.instanceId,
            ownerId: peer.session?.ownerId,
            deviceId: peer.session?.deviceId,
            sessionId: peer.session?.sessionId,
            closeCode: code,
            durationMs: Date.now() - connectedAt,
            outcome: 'disconnected',
          },
          'gateway'
        );
        clean();
      });
      socket.on('error', (err) => {
        service.options.logger.error({ err, stage: 'socket.transport', connectionId: peer.id }, 'gateway');
        socket.terminate();
        clean();
      });
    });
  let sweeping = false;
  const sweep = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      await service.sweep();
      // Durable polling recovers lost Pub/Sub wakeups. Targets only existing original sessions.
      for (const peer of service.peers.values()) if (peer.session) await service.pump(peer.session.deviceId);
    } catch (err) {
      service.options.logger.error({ err, stage: 'recovery.sweep' }, 'gateway');
    } finally {
      sweeping = false;
    }
  };
  await service.options.gatewayCoordinator.subscribe((deviceId) => {
    if (stopping) return;
    const active = service.pump(deviceId).catch((err) => {
      service.options.logger.error({ err, stage: 'routing.wake' }, 'gateway');
    });
    work.add(active);
    void active.then(
      () => work.delete(active),
      () => work.delete(active)
    );
  });
  const timer = setInterval(() => {
    if (stopping) return;
    const active = sweep();
    work.add(active);
    void active.then(
      () => work.delete(active),
      () => work.delete(active)
    );
  }, 5000);
  timer.unref();
  app.addHook('preClose', async () => {
    stopping = true;
    clearInterval(timer);
    const draining = [...serviceSockets];
    for (const rpc of draining) rpc.disconnect();
    for (const socket of app.websocketServer.clients) socket.terminate();
    for (const peer of pending) peer.close(1001);
    await Promise.allSettled([...work, ...draining.map((rpc) => rpc.drain())]);
    for (const peer of service.peers.values()) await service.dropped(peer);
  });
  return app;
}
