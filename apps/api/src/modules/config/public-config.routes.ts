import { PublicConfigSchema } from '@movie-hub/contract';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../config/env.js';

export function registerPublicConfigRoutes(app: FastifyInstance, config: AppConfig): void {
  app.get('/config', {
    schema: { response: { 200: PublicConfigSchema } },
  }, async () => ({
    avatar: {
      maxBytes: config.AVATAR_MAX_BYTES,
      maxPixels: config.AVATAR_MAX_PIXELS,
    },
  }));
}
