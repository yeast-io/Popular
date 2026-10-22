import { z } from 'zod';
import { ExternalUserIdSchema } from '../../modules/resource-sites/site-account-identity.schema.js';

export const MTeamMemberProfileSchema = z.object({
  data: z.object({ id: ExternalUserIdSchema }),
});
