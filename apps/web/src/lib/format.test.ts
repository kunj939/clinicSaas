import { addDaysIso, formatDate, localIsoDate } from './format';

describe('calendar formatting', () => {
  it('formats a clinic date without shifting it across timezones', () => {
    expect(formatDate('2026-10-31', 'en')).toContain('31');
    expect(formatDate('2026-10-01', 'en')).toContain('1');
  });

  it('adds days across month and year boundaries', () => {
    expect(addDaysIso('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('builds a YYYY-MM-DD string from the local date', () => {
    expect(localIsoDate(new Date(2026, 9, 5))).toBe('2026-10-05');
  });
});
