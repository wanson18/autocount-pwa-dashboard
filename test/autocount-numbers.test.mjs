import test from 'node:test';
import assert from 'node:assert/strict';
import numbers from '../lib/autocount/numbers.js';

const { decimalValue, firstNonZero, firstPositiveInteger } = numbers;

test('decimalValue reads finite numbers and exact decimal text', () => {
  assert.equal(decimalValue(12.5), 12.5);
  assert.equal(decimalValue('12.50'), 12.5);
  assert.equal(decimalValue('-2.50'), -2.5);
  assert.equal(decimalValue('3.000'), 3);
  assert.equal(decimalValue('.5'), 0.5);
  assert.equal(decimalValue('1e3'), 1000);
  assert.equal(decimalValue('+7'), 7);
});

test('decimalValue refuses everything that is not a finite decimal', () => {
  for (const value of [undefined, null, true, false, '', ' 12', '12 ', '12abc', '1,000.00', 'NaN', 'Infinity', '1e400', Infinity, -Infinity, NaN, {}, [], ['5']]) {
    assert.equal(decimalValue(value), null, String(value));
  }
});

test('firstNonZero gives what parseFloat(a || b || 0) gave for numbers, missing values and null', () => {
  assert.equal(firstNonZero(0, 12.5, 99), 12.5);
  assert.equal(firstNonZero(undefined, null, 7), 7);
  assert.equal(firstNonZero(-6, 10), -6);
  assert.equal(firstNonZero(), 0);
  assert.equal(firstNonZero(0, 0), 0);
});

test('firstNonZero lets every zero fall through, whether number or text', () => {
  for (const zero of [0, -0, '0', '0.00', '-0', '0e5']) {
    assert.equal(firstNonZero(zero, '25.50'), 25.5, JSON.stringify(zero));
  }
});

test('firstNonZero skips empty, malformed and out-of-range values', () => {
  assert.equal(firstNonZero('', '1.5'), 1.5);
  assert.equal(firstNonZero('12abc', '1.5'), 1.5);
  assert.equal(firstNonZero(' 12', '1.5'), 1.5);
  assert.equal(firstNonZero('1,000.00', '1.5'), 1.5);
  assert.equal(firstNonZero('1e400', '1.5'), 1.5);
  assert.equal(firstNonZero(Infinity, NaN, '1.5'), 1.5);
  assert.equal(firstNonZero(true, false, '1.5'), 1.5);
  assert.equal(firstNonZero('12abc'), 0);
});

test('firstPositiveInteger accepts only whole numbers above zero', () => {
  assert.equal(firstPositiveInteger('100'), 100);
  assert.equal(firstPositiveInteger('100.0'), 100);
  assert.equal(firstPositiveInteger(50), 50);
  assert.equal(firstPositiveInteger(0, '-5', '12.5', null, undefined, '25'), 25);
  assert.equal(firstPositiveInteger(0, -5, '12.5'), null);
  assert.equal(firstPositiveInteger(), null);
  assert.equal(firstPositiveInteger('9007199254740993'), null);
});
