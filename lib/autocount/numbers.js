'use strict';

// Reading AutoCount numbers. The AutoCount client hands numeric JSON tokens over
// as their exact text ("3.000", "-2.50"), so code that used to see JS numbers
// must not rely on truthiness: the text "0" is truthy. decimalValue is the one
// parser; everything else builds on it.

const DECIMAL_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

// A finite number, or exact decimal text (no spaces), as a JS number; else null.
function decimalValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !DECIMAL_RE.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// The first candidate that is a non-zero number, else 0. For finite numbers,
// missing values and null this is exactly Sales' former parseFloat(a || b || 0):
// a zero falls through to the next candidate.
function firstNonZero(...candidates) {
  for (const candidate of candidates) {
    const number = decimalValue(candidate);
    if (number !== null && number !== 0) return number;
  }
  return 0;
}

// The first candidate that is a whole number above zero, else null.
function firstPositiveInteger(...candidates) {
  for (const candidate of candidates) {
    const number = decimalValue(candidate);
    if (number !== null && Number.isSafeInteger(number) && number > 0) return number;
  }
  return null;
}

module.exports = { decimalValue, firstNonZero, firstPositiveInteger };
