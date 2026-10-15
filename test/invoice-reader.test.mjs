import test from 'node:test';
import assert from 'node:assert/strict';
import reader from '../lib/autocount/invoice-reader.js';

const { readInvoiceRange, readInvoicesChecked } = reader;

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

// --- readInvoicesChecked (Sales) -------------------------------------------

// A listPage that serves prepared pages in order and records each request.
function pagesOf(pages) {
  const calls = [];
  const listPage = async (params) => {
    calls.push(params);
    return pages[calls.length - 1] ?? { data: [] };
  };
  listPage.calls = calls;
  return listPage;
}

const row = (docKey) => ({ master: { docKey }, details: [] });
const sameDay = { accountBookId: '63750', startDate: day(0), endDate: day(0) };
const fullRange = { accountBookId: '63750', startDate: day(0), endDate: day(90) };
const isFullRange = (params) => params.startDate === day(0) && params.endDate === day(90);

test('checked read without any total stops at an empty page and reports check none', async () => {
  const listPage = pagesOf([{ data: [row('A'), row('B')] }, { data: [row('C')], totalCount: null }, { data: [] }]);
  const result = await readInvoicesChecked({ listPage, ...sameDay });
  assert.deepEqual(result.rows.map((r) => r.master.docKey), ['A', 'B', 'C']);
  assert.equal(result.check, 'none');
  assert.equal(result.problem, null);
  assert.equal(listPage.calls.length, 3);
});

test('checked read without a total also stops at a page shorter than a page size given as text', async () => {
  const listPage = pagesOf([{ data: [row('A'), row('B')], pageSize: '2' }, { data: [row('C')], pageSize: '2' }, { data: [row('never')] }]);
  const result = await readInvoicesChecked({ listPage, ...sameDay });
  assert.deepEqual(result.rows.map((r) => r.master.docKey), ['A', 'B', 'C']);
  assert.equal(result.check, 'none');
  assert.equal(listPage.calls.length, 2);
});

test('checked read accepts a total that grows while the pages are read', async () => {
  const first = Array.from({ length: 100 }, (_, i) => row(`K${i}`));
  const second = Array.from({ length: 51 }, (_, i) => row(`K${100 + i}`));
  const listPage = pagesOf([{ data: first, totalCount: 150 }, { data: second, totalCount: 151 }]);
  const result = await readInvoicesChecked({ listPage, ...sameDay });
  assert.equal(result.rows.length, 151);
  assert.equal(result.check, 'count');
  assert.equal(listPage.calls.length, 2);
});

test('rows without a readable document key are not counted as repeats', async () => {
  const listPage = pagesOf([{ data: [{ id: 1 }, { id: 1 }], totalCount: 2 }]);
  const result = await readInvoicesChecked({ listPage, ...sameDay });
  assert.equal(result.check, 'count');
});

test('a count mismatch alone triggers the slice re-read', async () => {
  const rows = rowsOverDays(DAYS);
  const honest = listPageOver(rows);
  const listPage = async (params) => {
    const payload = await honest(params);
    return isFullRange(params) && params.page === 2 ? { ...payload, data: payload.data.slice(0, -3) } : payload;
  };
  const rechecks = [];
  const result = await readInvoicesChecked({ listPage, ...fullRange, onRecheck: (problem) => rechecks.push(problem) });
  assert.deepEqual(keys(result.rows), keys(rows));
  assert.equal(result.check, 'slices');
  assert.equal(result.problem, 'row count does not match totalCount');
  assert.deepEqual(rechecks, ['row count does not match totalCount']);
});

test('a repeated document alone triggers the slice re-read', async () => {
  const rows = rowsOverDays(DAYS);
  const result = await readInvoicesChecked({ listPage: listPageOver(rows, { unstable: true }), ...fullRange });
  assert.deepEqual(keys(result.rows), keys(rows));
  assert.equal(result.check, 'slices');
  assert.equal(result.problem, 'an invoice is listed twice');
});

test('when both checks fail, the re-read happens once and the count mismatch is named', async () => {
  const unstable = listPageOver(rowsOverDays(DAYS), { unstable: true });
  const listPage = async (params) => {
    const payload = await unstable(params);
    return isFullRange(params) && params.page === 2 ? { ...payload, data: payload.data.slice(0, -3) } : payload;
  };
  const rechecks = [];
  const result = await readInvoicesChecked({ listPage, ...fullRange, onRecheck: (problem) => rechecks.push(problem) });
  assert.equal(result.check, 'slices');
  assert.equal(result.problem, 'row count does not match totalCount');
  assert.equal(rechecks.length, 1);
});

test('a list that stays short of its total, even in slices, throws', async () => {
  const honest = listPageOver(rowsOverDays(DAYS));
  const listPage = async (params) => {
    const payload = await honest(params);
    return { ...payload, data: payload.data.slice(0, Math.max(0, payload.data.length - 1)) };
  };
  await assert.rejects(() => readInvoicesChecked({ listPage, ...fullRange }), { code: 'PRICE_PAGE_INCOMPLETE' });
});

test('slices that do not add up to the overall total throw', async () => {
  // Every request silently drops its end date, so the slices cannot add up.
  const rows = rowsOverDays(DAYS);
  const listPage = async ({ page, startDate, endDate }) => {
    const matching = rows
      .filter((r) => r.master.docDate >= startDate && r.master.docDate < endDate)
      .sort((a, b) => `${a.master.docDate}${a.master.docKey}`.localeCompare(`${b.master.docDate}${b.master.docKey}`));
    const total = matching.length;
    const ordered = page > 1 && total > 0
      ? matching.map((_, i) => matching[(i - 13 * (page - 1) + total * 100) % total])
      : matching;
    return { totalCount: total, data: ordered.slice((page - 1) * 100, page * 100) };
  };
  await assert.rejects(() => readInvoicesChecked({ listPage, ...fullRange }), { code: 'PRICE_PAGE_INCOMPLETE' });
});

test('a present totalCount that is not a non-negative safe integer makes the page malformed', async () => {
  // Infinity is what the client makes of a 1e400 token.
  for (const totalCount of [-1, 2.5, Infinity, 2 ** 53, '100', true]) {
    await assert.rejects(
      () => readInvoicesChecked({ listPage: pagesOf([{ data: [row('A')], totalCount }]), ...sameDay }),
      { code: 'PRICE_SOURCE_INVALID' },
      String(totalCount),
    );
  }
});

test('a page without a total keeps the total of an earlier page', async () => {
  const listPage = pagesOf([{ data: [row('A'), row('B')], totalCount: 3 }, { data: [row('C')] }, { data: [] }]);
  const result = await readInvoicesChecked({ listPage, ...sameDay });
  assert.equal(result.check, 'count');
  assert.equal(result.rows.length, 3);
  assert.equal(listPage.calls.length, 3);
});

test('a page without a data array is malformed', async () => {
  for (const payload of [null, [], { data: null }, { rows: [] }]) {
    await assert.rejects(
      () => readInvoicesChecked({ listPage: async () => payload, ...sameDay }),
      { code: 'PRICE_SOURCE_INVALID' },
      JSON.stringify(payload),
    );
  }
});

test('the checked read stops at the page ceiling', async () => {
  const listPage = async ({ page }) => ({ data: [row(`K${page}`)] });
  await assert.rejects(
    () => readInvoicesChecked({ listPage, ...sameDay, maxPages: 5 }),
    { code: 'PRICE_PAGE_INCOMPLETE' },
  );
});

test('the checked read needs a listPage function', async () => {
  await assert.rejects(() => readInvoicesChecked({ ...sameDay }), { code: 'PRICE_SOURCE_INVALID' });
});
