import test from 'node:test';
import assert from 'node:assert/strict';
import comparison from '../lib/price-check/compare.js';

const { compareApprovedInvoices } = comparison;

const ENTERPRISE = { bookId: '63750', companyName: 'Enterprise', monitorFrom: '2026-09-15' };
const SDN_BHD = { bookId: '63688', companyName: 'Sdn Bhd', monitorFrom: '2026-09-15' };

function line(price, unit = 'CTN', productCode = 'ITEM-1', description = 'Sample item') {
  return { productCode, description, unit, qty: '2', unitPrice: price, subTotal: '20.00' };
}

function master(docNo, docDate, extra = {}) {
  return {
    docNo,
    docDate,
    debtorCode: '700-A001',
    debtorName: 'Sample',
    approverID: 5,
    approvedTimeStamp: `${docDate}T09:00:00`,
    cancelled: false,
    ...extra,
  };
}

function inv(docNo, docDate, price, unit = 'CTN', extra = {}) {
  return { master: master(docNo, docDate, extra), details: [line(price, unit)] };
}

function rawInv(docNo, docDate, details, extra = {}) {
  return { master: master(docNo, docDate, extra), details };
}

test('exact prior price and company boundary', () => {
  const rows = [inv('I-1', '2026-09-01', '10.00'), inv('I-2', '2026-09-20', '12.00')];
  const ent = compareApprovedInvoices(rows, ENTERPRISE);
  const sdn = compareApprovedInvoices([rows[1]], SDN_BHD);

  assert.equal(ent.alerts.length, 1);
  assert.equal(ent.alerts[0].type, 'PRICE_CHANGED');
  assert.equal(ent.alerts[0].differenceMYR, '2.00');
  assert.equal(ent.alerts[0].previousDocNo, 'I-1');
  assert.equal(ent.alerts[0].previousPrice, '10.00');
  assert.equal(ent.alerts[0].currentPrice, '12.00');

  assert.equal(sdn.alerts.length, 0);
  assert.equal(sdn.counts.noHistory, 1);
});

test('draft and cancelled references are excluded', () => {
  const rows = [
    inv('D-1', '2026-09-01', '8.00', 'CTN', { approverID: null }),
    inv('V-1', '2026-09-02', '9.00', 'CTN', { cancelled: true }),
    inv('I-2', '2026-09-20', '12.00'),
  ];
  const out = compareApprovedInvoices(rows, ENTERPRISE);

  assert.equal(out.alerts.length, 0);
  assert.equal(out.counts.noHistory, 1);
  assert.equal(out.counts.skippedUnapproved, 1);
  assert.equal(out.counts.skippedVoid, 1);
});

test('UOM change and invalid price are not numeric price alerts', () => {
  const rows = [
    inv('I-1', '2026-09-01', '10.00', 'TINS'),
    inv('I-2', '2026-09-20', '12.00', 'CTN'),
    inv('I-3', '2026-09-21', 'NaN', 'CTN'),
  ];
  const out = compareApprovedInvoices(rows, ENTERPRISE);

  assert.equal(out.alerts.length, 1);
  assert.equal(out.alerts[0].type, 'UOM_CHANGED');
  assert.equal(out.alerts[0].differenceMYR, null);
  assert.equal(out.alerts[0].differencePercent, null);
  assert.equal(out.alerts[0].uom, 'CTN');
  assert.equal(out.alerts[0].previousUom, 'TINS');
  assert.equal(out.counts.uomChanges, 1);
  assert.equal(out.counts.skippedInvalidLine, 1);
});

test('repeated same-item lines in one invoice are never prior history for each other', () => {
  const rows = [
    inv('I-1', '2026-09-01', '10.00'),
    rawInv('I-2', '2026-09-20', [line('12.00'), line('13.00')]),
  ];
  const out = compareApprovedInvoices(rows, ENTERPRISE);

  assert.equal(out.alerts.length, 2);
  assert.deepEqual(out.alerts.map((alert) => alert.differenceMYR), ['2.00', '3.00']);
  assert.equal(out.counts.compared, 2);
});

test('prior zero price reports a money delta with a null percentage', () => {
  const rows = [inv('Z-1', '2026-09-01', '0.00'), inv('Z-2', '2026-09-20', '5.00')];
  const out = compareApprovedInvoices(rows, ENTERPRISE);

  assert.equal(out.alerts.length, 1);
  assert.equal(out.alerts[0].differenceMYR, '5.00');
  assert.equal(out.alerts[0].differencePercent, null);
  assert.equal(out.alerts[0].previousPrice, '0.00');
});

test('rounds source prices to exact cents and signs money and percentage deltas', () => {
  const up = compareApprovedInvoices(
    [inv('R-1', '2026-09-01', '10.00'), inv('R-2', '2026-09-20', '10.005')],
    ENTERPRISE,
  );
  assert.equal(up.alerts[0].currentPrice, '10.01');
  assert.equal(up.alerts[0].differenceMYR, '0.01');
  assert.equal(up.alerts[0].differencePercent, '0.10');

  const collapsed = compareApprovedInvoices(
    [inv('C-1', '2026-09-01', '10.00'), inv('C-2', '2026-09-20', '10.004')],
    ENTERPRISE,
  );
  assert.equal(collapsed.alerts.length, 0);
  assert.equal(collapsed.counts.unchanged, 1);

  const down = compareApprovedInvoices(
    [inv('R-1', '2026-09-01', '10.00'), inv('R-2', '2026-09-20', '7.50')],
    ENTERPRISE,
  );
  assert.equal(down.alerts[0].differenceMYR, '-2.50');
  assert.equal(down.alerts[0].differencePercent, '-25.00');
});

test('invalid identity and prices are skipped, never treated as a zero match', () => {
  const rows = [
    rawInv('X-1', '2026-09-20', [line('12.00')], { debtorCode: '' }),
    rawInv('X-2', '2026-09-20', [line('12.00', 'CTN', '')]),
    rawInv('X-3', '2026-09-20', [line('12.00', '')]),
    rawInv('X-4', '2026-09-20', [line('not-a-number')]),
  ];
  const out = compareApprovedInvoices(rows, ENTERPRISE);

  assert.equal(out.alerts.length, 0);
  assert.equal(out.counts.skippedInvalidInvoice, 1);
  assert.equal(out.counts.skippedInvalidLine, 3);
  assert.equal(out.counts.noHistory, 0);
  assert.equal(out.counts.compared, 0);
});

test('approval requires approverID plus approvedTimeStamp, not status text or cancellation forms', () => {
  const rows = [
    inv('S-1', '2026-09-01', '8.00', 'CTN', {
      status: 'Approved',
      approverID: null,
      approvedTimeStamp: null,
    }),
    inv('S-2', '2026-09-01', '8.00', 'CTN', { approverID: 5, approvedTimeStamp: null }),
    inv('V-1', '2026-09-02', '9.00', 'CTN', { cancelled: true }),
    inv('V-2', '2026-09-03', '9.00', 'CTN', { isCancelled: true }),
    inv('V-3', '2026-09-04', '9.00', 'CTN', { cancelled: '1' }),
    inv('G-1', '2026-09-20', '12.00'),
  ];
  const out = compareApprovedInvoices(rows, ENTERPRISE);

  assert.equal(out.alerts.length, 0);
  assert.equal(out.counts.skippedUnapproved, 2);
  assert.equal(out.counts.skippedVoid, 3);
  assert.equal(out.counts.noHistory, 1);
});

test('rows without book metadata use the configured book identity', () => {
  const rows = [inv('I-1', '2026-09-01', '10.00'), inv('I-2', '2026-09-20', '12.00')];
  const out = compareApprovedInvoices(rows, SDN_BHD);

  assert.equal(out.alerts.length, 1);
  assert.equal(out.alerts[0].bookId, '63688');
  assert.equal(out.alerts[0].companyName, 'Sdn Bhd');
});

test('a row carrying a conflicting book identity fails instead of relabeling', () => {
  const onMaster = [
    inv('I-1', '2026-09-01', '10.00', 'CTN', { accountBookId: '63750' }),
    inv('I-2', '2026-09-20', '12.00', 'CTN', { accountBookId: '63750' }),
  ];
  assert.throws(
    () => compareApprovedInvoices(onMaster, SDN_BHD),
    { code: 'PRICE_BOOK_MISMATCH' },
  );

  const onRow = [inv('I-1', '2026-09-01', '10.00')];
  onRow[0].accountBookId = '63750';
  assert.throws(
    () => compareApprovedInvoices(onRow, SDN_BHD),
    { code: 'PRICE_BOOK_MISMATCH' },
  );

  const matching = [inv('I-1', '2026-09-01', '10.00', 'CTN', { accountBookId: '63750' })];
  assert.doesNotThrow(() => compareApprovedInvoices(matching, ENTERPRISE));
});

test('non-array input is rejected instead of returning a clean zero result', () => {
  assert.throws(
    () => compareApprovedInvoices(null, ENTERPRISE),
    { code: 'PRICE_ROWS_INVALID' },
  );
  assert.throws(
    () => compareApprovedInvoices({ rows: [] }, ENTERPRISE),
    { code: 'PRICE_ROWS_INVALID' },
  );

  const empty = compareApprovedInvoices([], ENTERPRISE);
  assert.deepEqual(empty.alerts, []);
  assert.equal(empty.counts.noHistory, 0);
});

test('debtor code and product code are hard comparison keys', () => {
  const rows = [
    inv('A-1', '2026-09-01', '10.00'),
    inv('B-1', '2026-09-20', '12.00', 'CTN', { debtorCode: '700-B002' }),
    rawInv('C-1', '2026-09-21', [line('12.00', 'CTN', 'ITEM-2')]),
  ];
  const out = compareApprovedInvoices(rows, ENTERPRISE);

  assert.equal(out.alerts.length, 0);
  assert.equal(out.counts.noHistory, 2);
});
