class DuplicateInvoiceError extends Error {
  constructor() {
    super('duplicate AutoCount invoice document key');
    this.name = 'DuplicateInvoiceError';
    this.code = 'duplicate_doc_key';
  }
}

class InvoiceDataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvoiceDataError';
    this.code = 'invalid_source_data';
  }
}

const DECIMAL_RE = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function exactPositiveDecimal(value, field) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new InvoiceDataError(`${field} is missing or invalid`);
  }
  const text = String(value).trim();
  if (!DECIMAL_RE.test(text) || Number(text) <= 0 || !Number.isFinite(Number(text))) {
    throw new InvoiceDataError(`${field} is invalid`);
  }
  return text;
}

function requiredText(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new InvoiceDataError(`${field} is missing or invalid`);
  }
  return value.trim();
}

function validIsoDate(value) {
  if (!ISO_DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime())
    && date.getUTCFullYear() === Number(value.slice(0, 4))
    && date.getUTCMonth() + 1 === Number(value.slice(5, 7))
    && date.getUTCDate() === Number(value.slice(8, 10));
}

function normalizeInvoice(row, company) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new InvoiceDataError('invoice row is malformed');
  }
  const master = row.master;
  const details = row.details;
  if (!master || typeof master !== 'object' || Array.isArray(master) || !Array.isArray(details)) {
    throw new InvoiceDataError('invoice row shape is malformed');
  }

  const docKey = requiredText(String(master.docKey ?? ''), 'docKey');
  const docNo = requiredText(master.docNo, 'docNo');
  const docDate = requiredText(master.docDate, 'docDate');
  if (!validIsoDate(docDate)) throw new InvoiceDataError('docDate is invalid');
  if (typeof master.cancelled !== 'boolean') {
    throw new InvoiceDataError('cancelled flag is invalid');
  }
  const cancelled = master.cancelled === true;
  const customerCode = requiredText(master.debtorCode, 'debtorCode');
  const customerName = requiredText(master.debtorName, 'debtorName');

  const items = details.map((detail) => {
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
      throw new InvoiceDataError('invoice detail row is malformed');
    }
    const itemCode = requiredText(detail.productCode, 'productCode');
    const description = requiredText(detail.description, 'description');
    const quantity = exactPositiveDecimal(detail.qty, 'qty');
    const uom = typeof detail.unit === 'string' && detail.unit.trim() ? detail.unit.trim() : null;
    return { itemCode, description, quantity, uom };
  });

  return {
    companyKey: company.companyKey,
    invoiceId: docKey,
    docKey,
    docNo,
    docDate,
    customer: { code: customerCode, name: customerName },
    deliveryAddress: typeof master.deliverAddress === 'string' ? master.deliverAddress.trim() : '',
    cancelled,
    eligibility: !items.length || items.some((item) => item.uom === null) ? 'blocked_missing_uom' : 'eligible',
    items,
  };
}

class InvoiceAdapter {
  constructor(client) {
    this.client = client;
  }

  async listInvoices(company, startDate, endDate) {
    const invoices = [];
    const seenDocKeys = new Set();
    let page = 1;
    let totalCount = null;

    while (totalCount === null || seenDocKeys.size < totalCount) {
      const payload = await this.client.listInvoicePage(company, { page, startDate, endDate });
      if (!payload || typeof payload !== 'object' || !Array.isArray(payload.data)) {
        throw new InvoiceDataError('invoice listing payload is malformed');
      }
      if (totalCount === null) {
        totalCount = Number.isInteger(payload.totalCount) && payload.totalCount >= 0
          ? payload.totalCount
          : payload.data.length;
      }
      if (payload.data.length === 0) {
        if (seenDocKeys.size < totalCount) throw new InvoiceDataError('invoice listing ended before totalCount');
        break;
      }

      for (const row of payload.data) {
        const invoice = normalizeInvoice(row, company);
        if (seenDocKeys.has(invoice.docKey)) throw new DuplicateInvoiceError();
        seenDocKeys.add(invoice.docKey);
        if (!invoice.cancelled) {
          await this._enrichMissingUom(invoice, company);
          invoices.push(invoice);
        }
      }
      if (seenDocKeys.size > totalCount) throw new InvoiceDataError('invoice listing exceeded totalCount');
      if (seenDocKeys.size >= totalCount) break;
      if (page >= 1000) throw new InvoiceDataError('invoice listing exceeded page limit');
      page += 1;
    }
    return invoices;
  }

  async _enrichMissingUom(invoice, company) {
    if (invoice.eligibility !== 'blocked_missing_uom' || typeof this.client.getProduct !== 'function') return;
    for (const item of invoice.items) {
      if (item.uom !== null) continue;
      try {
        const payload = await this.client.getProduct(company, item.itemCode);
        const product = payload && typeof payload === 'object' ? payload.product : null;
        const productCode = product && typeof product.productCode === 'string' ? product.productCode.trim() : '';
        const uom = productCode === item.itemCode && typeof product.unit === 'string'
          ? product.unit.trim()
          : '';
        if (uom) item.uom = uom;
      } catch (error) {
        // An unavailable authoritative UOM keeps the invoice blocked.
      }
    }
    invoice.eligibility = invoice.items.some((item) => item.uom === null)
      ? 'blocked_missing_uom'
      : 'eligible';
  }

}

module.exports = {
  DuplicateInvoiceError,
  InvoiceAdapter,
  InvoiceDataError,
  exactPositiveDecimal,
  normalizeInvoice,
};
