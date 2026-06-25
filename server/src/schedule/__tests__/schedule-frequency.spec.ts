import {
  buildScheduleCron,
  describeScheduleCron,
  isTimeBasedCron,
  parseScheduleCron,
  type ScheduleParts,
} from '@spinner/shared-types';

describe('schedule-frequency helpers', () => {
  describe('parseScheduleCron', () => {
    it('maps the fixed interval presets to their frequencies', () => {
      expect(parseScheduleCron('').frequency).toBe('manual');
      expect(parseScheduleCron('*/5 * * * *').frequency).toBe('every5m');
      expect(parseScheduleCron('*/30 * * * *').frequency).toBe('every30m');
      expect(parseScheduleCron('0 * * * *').frequency).toBe('hourly');
      expect(parseScheduleCron('* * * * *').frequency).toBe('everyMinute');
    });

    it('decodes the legacy "Daily" preset (0 0 * * *) as daily at 00:00', () => {
      const parts = parseScheduleCron('0 0 * * *');
      expect(parts.frequency).toBe('daily');
      expect(parts.hour).toBe(0);
      expect(parts.minute).toBe(0);
    });

    it('decodes a daily time-of-day cron', () => {
      const parts = parseScheduleCron('30 8 * * *');
      expect(parts).toMatchObject({ frequency: 'daily', hour: 8, minute: 30 });
    });

    it('decodes a weekly cron (Monday at 08:00)', () => {
      const parts = parseScheduleCron('0 8 * * 1');
      expect(parts).toMatchObject({ frequency: 'weekly', hour: 8, minute: 0, dayOfWeek: 1 });
    });

    it('decodes a monthly cron (5th at 08:00)', () => {
      const parts = parseScheduleCron('0 8 5 * *');
      expect(parts).toMatchObject({ frequency: 'monthly', hour: 8, minute: 0, dayOfMonth: 5 });
    });

    it('treats an unrecognized cron as custom and preserves the raw value', () => {
      const weird = '15 9 1,15 * 1-5';
      const parts = parseScheduleCron(weird);
      expect(parts.frequency).toBe('custom');
      expect(parts.raw).toBe(weird);
    });

    it('treats a malformed (non-5-field) cron as custom', () => {
      expect(parseScheduleCron('garbage').frequency).toBe('custom');
      expect(parseScheduleCron('0 8 * *').frequency).toBe('custom');
    });
  });

  describe('buildScheduleCron / round-trip', () => {
    const cases = [
      '',
      '*/5 * * * *',
      '*/30 * * * *',
      '0 * * * *',
      '* * * * *',
      '0 0 * * *',
      '30 8 * * *',
      '0 8 * * 1',
      '0 8 5 * *',
    ];

    it.each(cases)('round-trips %s through parse → build', (cron) => {
      expect(buildScheduleCron(parseScheduleCron(cron))).toBe(cron);
    });

    it('passes a custom cron through untouched (never reconstructed from parts)', () => {
      const weird = '15 9 1,15 * 1-5';
      expect(buildScheduleCron(parseScheduleCron(weird))).toBe(weird);
    });

    it('builds the expected cron from structured parts', () => {
      const base: ScheduleParts = { frequency: 'daily', hour: 6, minute: 0, dayOfWeek: 1, dayOfMonth: 1, raw: '' };
      expect(buildScheduleCron(base)).toBe('0 6 * * *');
      expect(buildScheduleCron({ ...base, frequency: 'weekly', dayOfWeek: 3 })).toBe('0 6 * * 3');
      expect(buildScheduleCron({ ...base, frequency: 'monthly', dayOfMonth: 15 })).toBe('0 6 15 * *');
    });
  });

  describe('isTimeBasedCron', () => {
    it('is true only for daily/weekly/monthly', () => {
      expect(isTimeBasedCron('0 8 * * *')).toBe(true);
      expect(isTimeBasedCron('0 8 * * 1')).toBe(true);
      expect(isTimeBasedCron('0 8 5 * *')).toBe(true);
      expect(isTimeBasedCron('')).toBe(false);
      expect(isTimeBasedCron('*/5 * * * *')).toBe(false);
      expect(isTimeBasedCron('0 * * * *')).toBe(false);
    });
  });

  describe('describeScheduleCron', () => {
    it('labels interval and manual frequencies', () => {
      expect(describeScheduleCron('')).toBe('Manual only');
      expect(describeScheduleCron('*/5 * * * *')).toBe('Every 5 minutes');
      expect(describeScheduleCron('0 * * * *')).toBe('Hourly');
    });

    it('labels time-based frequencies with the timezone', () => {
      expect(describeScheduleCron('0 8 * * *', 'America/New_York')).toBe('Daily at 8:00 AM · America/New_York');
      expect(describeScheduleCron('0 8 * * 1', 'America/New_York')).toBe(
        'Weekly on Mondays at 8:00 AM · America/New_York',
      );
      expect(describeScheduleCron('30 14 5 * *', 'Europe/Paris')).toBe('Monthly on the 5th at 2:30 PM · Europe/Paris');
    });

    it('omits the timezone suffix when none is given', () => {
      expect(describeScheduleCron('0 8 * * *')).toBe('Daily at 8:00 AM');
    });

    it('uses ordinal suffixes for day-of-month, including 29-31', () => {
      expect(describeScheduleCron('0 0 21 * *')).toBe('Monthly on the 21st at 12:00 AM');
      expect(describeScheduleCron('0 0 31 * *')).toBe('Monthly on the 31st at 12:00 AM');
    });

    it('falls back to the raw cron for a custom expression', () => {
      const weird = '15 9 1,15 * 1-5';
      expect(describeScheduleCron(weird)).toBe(weird);
    });
  });
});
