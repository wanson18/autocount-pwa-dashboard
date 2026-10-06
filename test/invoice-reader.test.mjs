import test from 'node:test';
import assert from 'node:assert/strict';
import reader from '../lib/autocount/invoice-reader.js';

const { readInvoiceRange } = reader;

const day = (offset) => new Date(Date.UTC(2026, 6, 8 + offset)).toISOString().slice(0, 10);

function rowsOverDays(perDay) {
  const rows = [];
  perDay.forEach((count, d) => {
    for (let i = 0; i < count; i += 1) rows.push({ master: { docKey: `K-${d}-${i}`, docDate: day(d) }, details: [] });
  });
  return rows;
}

// A listPage over a fixed set of rows: 100-row pages, optionally ordering later pages differently so they overlap.
function listPageOver(rows, { unstable = false } = {}) {
  const calls = [];
  const listPage = async ({ page, startDate, endDate }) => {
    calls.push({ page, startDate, endDate });
    const matching = rows
      .filter((row) => row.master.docDate >= startDate && row.master.docDate <= endDate)
      .sort((a, b) => `${a.master.docDate}${a.master.docKey}`.localeCompare(`${b.master.docDate}${b.master.docKey}`));
    const total = matching.length;
    const ordered = unstable && page > 1 && total > 0
      ? matching.map((_, i) => matching[(i - 13 * (page - 1) + total * 100) % total])
      : matching;
    return { totalCount: total, data: ordered.slice((page - 1) * 100, page * 100) };
  };
  listPage.calls = calls;
  return listPage;
}

const DAYS = Array.from({ length: 91 }, (_, d) => 5 + ((d * 7) % 23));
const keys = (rows) => rows.map((row) => row.master.docKey).sort();

test('paged strategy reads a stable listing page by page and counts the requests', async () => {
  const rows = rowsOverDays(DAYS);
  const listPage = listPageOver(rows);
  const result = await readInvoiceRange({ listPage, accountBookId: '63750', startDate: day(0), endDate: day(90) });

  assert.deepEqual(keys(result.rows), keys(rows));
  assert.equal(result.pageCount, Math.ceil(rows.length / 100));
  assert.deepEqual(listPage.calls.map((call) => call.page), listPage.calls.map((_, i) => i + 1));
});

test('paged strategy fails on a listing that repeats invoices, with numbers only', async () => {
  const listPage = listPageOver(rowsOverDays(DAYS), { unstable: true });
  await assert.rejects(
    () => readInvoiceRange({ listPage, accountBookId: '63750', startDate: day(0), endDate: day(90), strategy: 'paged' }),
    (error) => {
      assert.equal(error.code, 'PRICE_DUPLICATE_DOC');
      assert.equal(error.retryable, true);
      assert.ok(Number.isInteger(error.detail.page) && Number.isInteger(error.detail.rowOnPage));
      assert.equal(JSON.stringify(error.detail).includes('K-'), false, 'no invoice text in the diagnostics');
      return true;
    },
  );
});

test('windowed strategy returns every invoice once from the same repeating listing', async () => {
  const rows = rowsOverDays(DAYS);
  const listPage = listPageOver(rows, { unstable: true });
  const result = await readInvoiceRange({ listPage, accountBookId: '63750', startDate: day(0), endDate: day(90), strategy: 'windowed' });

  assert.deepEqual(keys(result.rows), keys(rows));
  assert.equal(result.pageCount, listPage.calls.length);
  assert.ok(listPage.calls.every((call) => call.page === 1), 'every slice fits on one page');
});

test('bad input is rejected before any request is made', async () => {
  const listPage = listPageOver([]);
  await assert.rejects(() => readInvoiceRange({ accountBookId: '63750', startDate: day(0), endDate: day(1) }), { code: 'PRICE_SOURCE_INVALID' });
  await assert.rejects(
    () => readInvoiceRange({ listPage, accountBookId: '63750', startDate: day(0), endDate: day(1), strategy: 'sideways' }),
    { code: 'PRICE_SOURCE_INVALID' },
  );
  assert.equal(listPage.calls.length, 0);
});
