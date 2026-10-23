import messages from './locales/messages.json';
import type { Locale } from './settings.types';

export function queueDate(value: number, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(value);
}
export function queueRemaining(expiry: number, now: number, locale: Locale): string {
  const text = messages[locale];
  const remaining = expiry - now;
  if (remaining <= 0) return text.queueExpired;
  const minutes = Math.max(1, Math.ceil(remaining / 60000));
  const unit = minutes >= 1440 ? 'day' : minutes >= 60 ? 'hour' : 'minute';
  const count = unit === 'day' ? Math.ceil(minutes / 1440) : unit === 'hour' ? Math.ceil(minutes / 60) : minutes;
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'short' }).format(count);
}
