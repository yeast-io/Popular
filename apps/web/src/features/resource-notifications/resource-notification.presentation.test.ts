import { expect, it } from 'vitest';
import { nextCheckLabel } from './resource-notification.presentation';

for (const locale of ['zh-CN', 'en-US'] as const) {
  it(`formats local today, tomorrow, later dates and year boundaries in ${locale}`, () => {
    const now = new Date(2026, 10, 7, 14, 0);
    expect(nextCheckLabel(new Date(2026, 10, 7, 17, 30).toISOString(), locale, now)).toBe('17:30');
    expect(nextCheckLabel(new Date(2026, 10, 8, 9, 30).toISOString(), locale, now))
      .toBe(locale === 'zh-CN' ? '明天 09:30' : 'Tomorrow 09:30');
    const later = new Date(2026, 10, 9, 9, 30);
    expect(nextCheckLabel(later.toISOString(), locale, now)).toBe(new Intl.DateTimeFormat(locale, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(later));
    expect(nextCheckLabel(new Date(2027, 0, 2, 9, 30).toISOString(), locale, now)).toContain('2027');
    expect(nextCheckLabel(new Date(2027, 0, 1, 0, 5).toISOString(), locale, new Date(2026, 11, 31, 23, 59)))
      .toBe(locale === 'zh-CN' ? '明天 00:05' : 'Tomorrow 00:05');
    expect(nextCheckLabel('invalid', locale, now)).toBe('');
  });
}
