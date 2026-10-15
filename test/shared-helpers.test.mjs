import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

// Files that check calendar dates or do day arithmetic. Each must use lib/dates.js.
const DATE_CHECK_FILES = [
  'api/dispatch-invoices.js',
  'api/dispatch-assignments.js',
  'lib/dispatch/service.js',
  'lib/dispatch/invoice-adapter.js',
  'lib/price-check/source.js',
  'lib/price-check/compare.js',
  'lib/autocount/invoice-reader.js',
];

test('calendar date checks and day arithmetic live only in lib/dates.js', () => {
  for (const file of DATE_CHECK_FILES) {
    const source = read(file);
    assert.doesNotMatch(source, /function (isValidDate|validIsoDate|addDays|diffDays|malaysiaDate)\b/, file);
    assert.doesNotMatch(source, /getUTCDate\(\) [!=]== Number\(/, file);
    assert.match(source, /require\('(\.\.\/)+(lib\/)?dates'\)/, `${file} uses lib/dates.js`);
  }
});

function sourceFiles(dir) {
  return readdirSync(new URL(`../${dir}/`, import.meta.url), { recursive: true })
    .map((name) => `${dir}/${String(name).replaceAll('\\', '/')}`)
    .filter((file) => file.endsWith('.js') && !file.endsWith('.test.js'));
}

test('the two book numbers are typed in one file only', () => {
  const typed = [...sourceFiles('api'), ...sourceFiles('lib')]
    .filter((file) => /\b(63750|63688)\b/.test(read(file)));
  assert.deepEqual(typed, ['lib/autocount/company-config.js']);
});
