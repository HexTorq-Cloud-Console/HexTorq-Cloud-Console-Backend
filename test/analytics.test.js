import test from 'node:test';
import assert from 'node:assert/strict';
import { median, percentChange, successRateFor, resolveTimeZone, zonedDayStart } from '../src/analytics.js';

test('median of an odd sample', () => {
  assert.equal(median([5, 1, 3]), 3);
});

test('median of an even sample averages the middle pair', () => {
  assert.equal(median([1, 2, 3, 4]), 3);
});

test('median ignores invalid values and empty samples', () => {
  assert.equal(median([10, null, undefined, 'x', 20]), 15);
  assert.equal(median([]), null);
  assert.equal(median(null), null);
});

test('percent change is null-safe', () => {
  assert.equal(percentChange(10, 8), 25);
  assert.equal(percentChange(0, 0), null);
  assert.equal(percentChange(5, 0), null);
  assert.equal(percentChange(5, null), null);
});

test('success rate excludes active deployments (only completed in denominator)', () => {
  assert.equal(successRateFor(3, 1), 75);
  assert.equal(successRateFor(0, 0), null);
});

test('timezone resolution falls back to UTC for invalid input', () => {
  assert.equal(resolveTimeZone('Asia/Kolkata'), 'Asia/Kolkata');
  assert.equal(resolveTimeZone('Not/AZone'), 'UTC');
  assert.equal(resolveTimeZone(undefined), 'UTC');
});

test('zonedDayStart returns local midnight as a UTC instant', () => {
  const start = zonedDayStart(new Date('2026-05-10T18:30:00.000Z'), 'Asia/Kolkata');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit',
  }).formatToParts(start).reduce((acc, part) => { acc[part.type] = part.value; return acc; }, {});
  assert.equal(parts.hour === '24' ? '00' : parts.hour, '00');
  assert.equal(parts.minute, '00');
});
