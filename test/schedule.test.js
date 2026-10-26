import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addScheduledDays,
  nextScheduledRun,
  nextScheduledRunAfter,
  resolveScheduleOptions,
} from '../src/schedule.js';

const kolkata = { timeZone: 'Asia/Kolkata', hour: 3 };

test('next run is today when the scheduled hour is still ahead', () => {
  const now = new Date('2026-10-25T20:00:00.000Z'); // 2026-10-26 01:30 IST
  assert.equal(nextScheduledRun(now, kolkata).toISOString(), '2026-10-25T21:30:00.000Z');
});

test('next run moves to tomorrow after the scheduled hour', () => {
  const now = new Date('2026-10-25T22:30:00.000Z'); // 2026-10-26 04:00 IST
  assert.equal(nextScheduledRun(now, kolkata).toISOString(), '2026-10-26T21:30:00.000Z');
});

test('scheduled days preserve the 03:00 wall clock in the configured zone', () => {
  const due = new Date('2026-10-25T21:30:00.000Z');
  assert.equal(addScheduledDays(due, 7, kolkata).toISOString(), '2026-11-01T21:30:00.000Z');
});

test('next run after an old due date catches up to a future interval boundary', () => {
  const due = new Date('2026-10-01T21:30:00.000Z');
  const now = new Date('2026-10-25T20:00:00.000Z');
  assert.equal(
    nextScheduledRunAfter(due, 7, now, kolkata).toISOString(),
    '2026-10-29T21:30:00.000Z',
  );
});

test('DST transitions preserve the 03:00 wall clock', () => {
  const due = new Date('2026-03-07T08:00:00.000Z'); // 2026-03-07 03:00 EST
  const next = addScheduledDays(due, 1, { timeZone: 'America/New_York', hour: 3 });
  assert.equal(next.toISOString(), '2026-03-08T07:00:00.000Z'); // 2026-03-08 03:00 EDT
});

test('UTC schedules are supported and options are validated', () => {
  const utc = resolveScheduleOptions({ timeZone: 'UTC', hour: 3 });
  assert.equal(utc.hour, 3);
  assert.throws(() => resolveScheduleOptions({ timeZone: 'Not/AZone', hour: 3 }), /Invalid webhook schedule timezone/);
  assert.throws(() => resolveScheduleOptions({ timeZone: 'UTC', hour: 24 }), /between 0 and 23/);
});
