import { z } from 'zod';

export const gatewayAuthorizationAcknowledgementSchema = z.object({ applied: z.literal(true) });
