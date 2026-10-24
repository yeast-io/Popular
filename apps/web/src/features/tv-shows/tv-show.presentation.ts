import { t } from '../../i18n';
import type { TranslationKey } from '../../i18n/translation.types';

const statusKeys: Record<string, TranslationKey> = {
  'Returning Series': 'tv.status.returning', 'Ended': 'tv.status.ended', 'Canceled': 'tv.status.canceled',
  'In Production': 'tv.status.production', 'Planned': 'tv.status.planned', 'Pilot': 'tv.status.pilot',
};
export const tvStatusLabel = (status?: string): string => t(status && statusKeys[status] ? statusKeys[status]! : 'tv.unknown');
