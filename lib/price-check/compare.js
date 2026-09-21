'use strict';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})T/;
const PRICE_RE = /^(\d+)(?:\.(\d+))?$/;
const KEY_SEPARATOR = '\u0000';

function hasValue(value) {
  if (value === null || value === undefined) return false;
  return String(value).trim() !== '';
}

function compareError(message, code, name) {
  const error = new Error(message);
  error.name = name;
  error.code = code;
  return error;
}

function assertBookIdentity(row, bookId) {
  if (!hasValue(bookId)) return;
  const configured = String(bookId).trim();
  const declared = [];
  if (row && typeof row === 'object' && !Array.isArray(row)) {
    if (hasValue(row.accountBookId)) declared.push(row.accountBookId);
    const master = row.master;
    if (master && typeof master === 'object' && !Array.isArray(master)
      && hasValue(master.accountBookId)) {
      declared.push(master.accountBookId);
    }
  }
  for (const value of declared) {
    if (String(value).trim() !== configured) {
      throw compareError(
        'invoice row book identity does not match the configured book',
        'PRICE_BOOK_MISMATCH',
        'PriceBookMismatchError',
      );
    }
  }
}

function flagged(value) {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    return text === '1' || text === 'true';
  }
  return false;
}

function toCents(value) {
  const text = String(value ?? '').trim();
  const match = PRICE_RE.exec(text);
  if (!match) throw new TypeError('invalid unit price');
  const fraction = (match[2] || '').padEnd(3, '0');
  return BigInt(match[1]) * 100n + BigInt(fraction.slice(0, 2))
    + (fraction[2] >= '5' ? 1n : 0n);
}

function formatCents(cents) {
  const negative = cents < 0n;
  const magnitude = negative ? -cents : cents;
  const whole = magnitude / 100n;
  const fraction = magnitude % 100n;
  return `${negative ? '-' : ''}${whole}.${String(fraction).padStart(2, '0')}`;
}

function formatPercent(differenceCents, previousCents) {
  if (previousCents === 0n) return null;
  const negative = differenceCents < 0n;
  const magnitude = negative ? -differenceCents : differenceCents;
  const rounded = (magnitude * 20000n + previousCents) / (previousCents * 2n);
  return formatCents(negative ? -rounded : rounded);
}

function validIsoDate(value) {
  if (!ISO_DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime())
    && date.getUTCFullYear() === Number(value.slice(0, 4))
    && date.getUTCMonth() + 1 === Number(value.slice(5, 7))
    && date.getUTCDate() === Number(value.slice(8, 10));
}

function readDocDate(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const date = ISO_DATE_RE.test(text) ? text : ISO_DATE_TIME_RE.exec(text)?.[1];
  if (!date || !validIsoDate(date)) return null;
  return date;
}

function readInvoice(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const master = row.master;
  if (!master || typeof master !== 'object' || Array.isArray(master)) return null;
  if (!Array.isArray(row.details)) return null;

  const docNo = typeof master.docNo === 'string' ? master.docNo.trim() : '';
  if (!docNo) return null;
  const docDate = readDocDate(master.docDate);
  if (!docDate) return null;
  const customerCode = typeof master.debtorCode === 'string' ? master.debtorCode.trim() : '';
  if (!customerCode) return null;
  const customerName = typeof master.debtorName === 'string' ? master.debtorName.trim() : '';

  return {
    docNo,
    docDate,
    customerCode,
    customerName,
    approved: hasValue(master.approverID) && hasValue(master.approvedTimeStamp),
    cancelled: flagged(master.cancelled) || flagged(master.isCancelled),
    stamp: hasValue(master.approvedTimeStamp) ? String(master.approvedTimeStamp).trim() : '',
    details: row.details,
  };
}

function readLine(detail) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const itemCode = typeof detail.productCode === 'string' ? detail.productCode.trim() : '';
  if (!itemCode) return null;

  const sourceUom = typeof detail.unit === 'string' && detail.unit.trim()
    ? detail.unit
    : (typeof detail.uom === 'string' ? detail.uom : '');
  const uom = sourceUom.trim();
  if (!uom) return null;

  let priceCents;
  try {
    priceCents = toCents(detail.unitPrice);
  } catch (error) {
    return null;
  }

  return {
    itemCode,
    uom,
    priceCents,
    description: typeof detail.description === 'string' ? detail.description.trim() : '',
  };
}

function compareOrder(left, right) {
  if (left.docDate !== right.docDate) return left.docDate < right.docDate ? -1 : 1;
  if (left.stamp !== right.stamp) return left.stamp < right.stamp ? -1 : 1;
  if (left.docNo !== right.docNo) return left.docNo < right.docNo ? -1 : 1;
  return 0;
}

function makeAlert({ bookId, companyName }, invoice, line, previous, type) {
  const differenceCents = line.priceCents - previous.priceCents;
  const sameUom = type === 'PRICE_CHANGED';
  return {
    bookId,
    companyName,
    docNo: invoice.docNo,
    docDate: invoice.docDate,
    customerCode: invoice.customerCode,
    customerName: invoice.customerName,
    itemCode: line.itemCode,
    description: line.description,
    uom: line.uom,
    previousUom: previous.uom,
    currentPrice: formatCents(line.priceCents),
    previousPrice: formatCents(previous.priceCents),
    differenceMYR: type === 'PRICE_CHANGED' ? formatCents(differenceCents) : null,
    differencePercent: sameUom ? formatPercent(differenceCents, previous.priceCents) : null,
    previousDocNo: previous.docNo,
    previousDocDate: previous.docDate,
    type,
  };
}

function compareApprovedInvoices(rows, options = {}) {
  const { bookId = null, companyName = null, monitorFrom = null } = options || {};
  const counts = {
    invoices: 0,
    approvedInvoices: 0,
    monitoredInvoices: 0,
    lines: 0,
    compared: 0,
    priceChanges: 0,
    uomChanges: 0,
    unchanged: 0,
    noHistory: 0,
    skippedInvalidInvoice: 0,
    skippedUnapproved: 0,
    skippedVoid: 0,
    skippedInvalidLine: 0,
  };
  if (!Array.isArray(rows)) {
    throw compareError('invoice rows must be an array', 'PRICE_ROWS_INVALID', 'PriceRowsInvalidError');
  }

  const alerts = [];
  const invoices = [];

  for (const row of rows) {
    counts.invoices += 1;
    assertBookIdentity(row, bookId);
    const invoice = readInvoice(row);
    if (!invoice) {
      counts.skippedInvalidInvoice += 1;
      continue;
    }
    if (!invoice.approved) {
      counts.skippedUnapproved += 1;
      continue;
    }
    if (invoice.cancelled) {
      counts.skippedVoid += 1;
      continue;
    }
    invoices.push(invoice);
  }

  invoices.sort(compareOrder);

  const priorByItem = new Map();
  for (const invoice of invoices) {
    counts.approvedInvoices += 1;
    const monitored = !monitorFrom || invoice.docDate >= monitorFrom;
    if (monitored) counts.monitoredInvoices += 1;

    const updates = new Map();
    for (const detail of invoice.details) {
      counts.lines += 1;
      const line = readLine(detail);
      if (!line) {
        counts.skippedInvalidLine += 1;
        continue;
      }

      const key = `${invoice.customerCode}${KEY_SEPARATOR}${line.itemCode}`;
      const previous = priorByItem.get(key);
      if (previous) {
        if (monitored) counts.compared += 1;
        if (previous.uom !== line.uom) {
          if (monitored) {
            counts.uomChanges += 1;
            alerts.push(makeAlert({ bookId, companyName }, invoice, line, previous, 'UOM_CHANGED'));
          }
        } else if (line.priceCents === previous.priceCents) {
          if (monitored) counts.unchanged += 1;
        } else if (monitored) {
          counts.priceChanges += 1;
          alerts.push(makeAlert({ bookId, companyName }, invoice, line, previous, 'PRICE_CHANGED'));
        }
      } else if (monitored) {
        counts.noHistory += 1;
      }

      updates.set(key, line);
    }

    for (const [key, line] of updates) {
      priorByItem.set(key, {
        uom: line.uom,
        priceCents: line.priceCents,
        docNo: invoice.docNo,
        docDate: invoice.docDate,
      });
    }
  }

  return { alerts, counts };
}

module.exports = {
  compareApprovedInvoices,
  toCents,
  formatCents,
  formatPercent,
};
