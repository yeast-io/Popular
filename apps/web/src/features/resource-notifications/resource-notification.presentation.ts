import type { Locale } from '@movie-hub/contract';
import { translate } from '../../i18n';

export function nextCheckLabel(value: string, locale: Locale, now = new Date()): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
  if (date.toDateString() === now.toDateString()) return time;
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (date.toDateString() === tomorrow.toDateString()) return translate(locale, 'resourceNotifications.tomorrow', { time });
  return new Intl.DateTimeFormat(locale, {
    ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date);
}
