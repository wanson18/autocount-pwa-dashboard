'use strict';

// Calendar dates as YYYY-MM-DD text, shared by Sales, Dispatch and Price Check.
// Validation is plain arithmetic: a JavaScript Date would quietly turn
// 31 February into 3 March, and Date.UTC reads years 0-99 as 1900-1999.

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86400000;

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function parseIsoDate(value) {
  if (typeof value !== 'string') return null;
  const match = ISO_DATE_RE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

function isIsoDate(value) {
  return parseIsoDate(value) !== null;
}

function requireIsoDate(value) {
  const parts = parseIsoDate(value);
  if (!parts) throw new RangeError('expected a YYYY-MM-DD calendar date');
  return parts;
}

// Milliseconds since 1970-01-01 UTC. setUTCFullYear keeps years 0-99 as written.
function utcMillis({ year, month, day }) {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getTime();
}

function formatIsoDate(millis) {
  const date = new Date(millis);
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(isoDate, delta) {
  if (!Number.isSafeInteger(delta)) throw new RangeError('expected a whole number of days');
  return formatIsoDate(utcMillis(requireIsoDate(isoDate)) + delta * DAY_MS);
}

function diffDays(fromIso, toIso) {
  return Math.round((utcMillis(requireIsoDate(toIso)) - utcMillis(requireIsoDate(fromIso))) / DAY_MS);
}

// Today's date in a time zone. Throws a RangeError for a zone that does not exist.
function todayIn(timeZone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

module.exports = { addDays, diffDays, isIsoDate, todayIn };
