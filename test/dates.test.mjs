import test from 'node:test';
import assert from 'node:assert/strict';
import dates from '../lib/dates.js';

const { addDays, diffDays, isIsoDate, todayIn } = dates;

test('isIsoDate accepts real calendar dates, including leap days', () => {
  for (const value of ['2026-10-15', '2024-02-29', '2000-02-29', '2026-12-31', '2026-01-01', '0050-06-15']) {
    assert.equal(isIsoDate(value), true, value);
  }
});

test('isIsoDate rejects impossible dates instead of rolling them over', () => {
  for (const value of [
    '2026-02-29', '2100-02-29', '2026-02-31', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-00',
    '2026-1-01', ' 2026-01-01', '2026-01-01 ', '2026-01-01T00:00:00Z', '',
  ]) {
    assert.equal(isIsoDate(value), false, JSON.stringify(value));
  }
});

test('isIsoDate rejects anything that is not a string', () => {
  for (const value of [undefined, null, 20261015, new Date('2026-10-15T00:00:00Z'), ['2026-10-15'], { date: '2026-10-15' }]) {
    assert.equal(isIsoDate(value), false);
  }
});

test('addDays rolls over months, years and leap days in UTC', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-03-01', -1), '2028-02-29');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2026-01-15', -90), '2025-10-17');
  assert.equal(addDays('2026-10-15', 0), '2026-10-15');
});

test('addDays keeps years 0-99 as written and zero-pads them', () => {
  assert.equal(addDays('0050-01-01', 1), '0050-01-02');
  assert.equal(addDays('0099-12-31', 1), '0100-01-01');
});

test('diffDays counts calendar days across a leap day and a year end', () => {
  assert.equal(diffDays('2028-02-28', '2028-03-01'), 2);
  assert.equal(diffDays('2026-02-28', '2026-03-01'), 1);
  assert.equal(diffDays('2025-10-17', '2026-01-15'), 90);
  assert.equal(diffDays('2026-01-15', '2025-10-17'), -90);
});

test('addDays and diffDays refuse input that is not a calendar date', () => {
  assert.throws(() => addDays('2026-02-31', 1), RangeError);
  assert.throws(() => addDays('2026-10-15', 1.5), RangeError);
  assert.throws(() => diffDays('2026-10-15', '2026-13-01'), RangeError);
});

test('todayIn moves to the next Malaysian day at exactly 16:00 UTC', () => {
  assert.equal(todayIn('Asia/Kuala_Lumpur', new Date('2026-10-15T15:59:59.999Z')), '2026-10-15');
  assert.equal(todayIn('Asia/Kuala_Lumpur', new Date('2026-10-15T16:00:00.000Z')), '2026-10-16');
  assert.equal(todayIn('Asia/Kuala_Lumpur', new Date('2026-12-31T16:00:00.000Z')), '2027-01-01');
  assert.equal(todayIn('Asia/Kuala_Lumpur', new Date('2028-02-28T16:00:00.000Z')), '2028-02-29');
  assert.equal(todayIn('Asia/Kuala_Lumpur', new Date('2026-02-28T16:00:00.000Z')), '2026-03-01');
});

test('todayIn throws on a time zone that does not exist', () => {
  assert.throws(() => todayIn('Not/AZone', new Date('2026-10-15T00:00:00Z')), RangeError);
});
