const COMPANY_KEYS = ['enterprise', 'sdn_bhd'];
const COMPANY_NAMES = Object.freeze({
  enterprise: 'Wanson Enterprise',
  sdn_bhd: 'Wanson Enterprise (M) Sdn Bhd',
});
const DECIMAL_RE = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const MAX_DECIMAL_SCALE = 10000;

function invalidDecimal(value) {
  const error = new TypeError(`invalid decimal quantity: ${String(value)}`);
  error.code = 'invalid_snapshot_quantity';
  return error;
}

function parseDecimal(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || !DECIMAL_RE.test(value)) {
    throw invalidDecimal(value);
  }
  const [coefficient, exponentText] = value.split(/[eE]/);
  const [whole, fractional = ''] = coefficient.split('.');
  const exponent = exponentText === undefined ? 0n : BigInt(exponentText);
  const scaleBig = BigInt(fractional.length) - exponent;
  if (scaleBig < BigInt(-MAX_DECIMAL_SCALE) || scaleBig > BigInt(MAX_DECIMAL_SCALE)) {
    throw invalidDecimal(value);
  }
  const digits = `${whole}${fractional}`.replace(/^0+(?=\d)/, '') || '0';
  return { digits: BigInt(digits), scale: Number(scaleBig) };
}

function decimalIntegerAtScale(decimal, scale) {
  if (decimal.scale <= scale) {
    return decimal.digits * (10n ** BigInt(scale - decimal.scale));
  }
  return decimal.digits / (10n ** BigInt(decimal.scale - scale));
}

function formatDecimal(integer, scale) {
  const digits = integer.toString();
  if (scale <= 0) return `${digits}${'0'.repeat(-scale)}`;
  const padded = digits.padStart(scale + 1, '0');
  return `${padded.slice(0, -scale)}.${padded.slice(-scale)}`;
}

function addDecimalStrings(left, right) {
  const first = parseDecimal(left);
  const second = parseDecimal(right);
  const scale = Math.max(0, first.scale, second.scale);
  return formatDecimal(
    decimalIntegerAtScale(first, scale) + decimalIntegerAtScale(second, scale),
    scale,
  );
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function valueOf(value, ...keys) {
  for (const key of keys) {
    if (value?.[key] !== undefined && value?.[key] !== null) return value[key];
  }
  return undefined;
}

function stringOrEmpty(value) {
  return value === undefined || value === null ? '' : String(value);
}

function timestampValue(value) {
  if (value instanceof Date) return value.toISOString();
  return value === undefined || value === null ? null : String(value);
}

function safeDriver(trip) {
  const driver = asObject(trip.driver);
  const id = valueOf(driver, 'id') ?? valueOf(trip, 'driverId', 'driver_id');
  const name = valueOf(driver, 'name') ?? valueOf(trip, 'driverName', 'driver_name');
  const licenseNo = valueOf(driver, 'licenseNo', 'license_no')
    ?? valueOf(trip, 'driverLicenseNo', 'driver_license_no');
  return id === undefined && name === undefined && licenseNo === undefined
    ? null
    : { id: id ?? null, name: stringOrEmpty(name), licenseNo: stringOrEmpty(licenseNo) };
}

function safeLorry(trip) {
  const lorry = asObject(trip.lorry ?? trip.vehicle);
  const id = valueOf(lorry, 'id') ?? valueOf(trip, 'vehicleId', 'vehicle_id');
  const registrationNo = valueOf(lorry, 'registrationNo', 'registration_no')
    ?? valueOf(trip, 'registrationNo', 'vehicleRegistrationNo', 'vehicle_registration_no');
  const description = valueOf(lorry, 'description')
    ?? valueOf(trip, 'vehicleDescription', 'vehicle_description');
  return id === undefined && registrationNo === undefined && description === undefined
    ? null
    : { id: id ?? null, registrationNo: stringOrEmpty(registrationNo), description: stringOrEmpty(description) };
}

function safeCustomer(header, assignment) {
  const customer = asObject(header.customer ?? assignment.customer);
  return {
    code: stringOrEmpty(valueOf(customer, 'code', 'customerCode', 'customer_code')),
    name: stringOrEmpty(valueOf(customer, 'name', 'customerName', 'customer_name')),
  };
}

function safeInvoice(assignment) {
  const header = asObject(assignment.header ?? assignment.invoiceHeader ?? assignment.invoice_header);
  const companyKey = valueOf(assignment, 'companyKey', 'company_key') ?? valueOf(header, 'companyKey', 'company_key');
  const invoiceId = valueOf(assignment, 'invoiceId', 'invoice_id')
    ?? valueOf(header, 'invoiceId', 'invoice_id', 'docKey', 'doc_key');
  return {
    companyKey,
    companyName: COMPANY_NAMES[companyKey] || companyKey,
    invoiceId: stringOrEmpty(invoiceId),
    docNo: stringOrEmpty(valueOf(assignment, 'docNo', 'doc_no') ?? valueOf(header, 'docNo', 'doc_no')),
    docDate: stringOrEmpty(valueOf(assignment, 'docDate', 'doc_date') ?? valueOf(header, 'docDate', 'doc_date')),
    customer: safeCustomer(header, assignment),
    status: stringOrEmpty(valueOf(assignment, 'status', 'assignmentStatus', 'assignment_status')),
    assignedAt: timestampValue(valueOf(assignment, 'assignedAt', 'assigned_at')),
    updatedAt: timestampValue(valueOf(assignment, 'updatedAt', 'updated_at')),
    items: Array.isArray(assignment.items) ? assignment.items : [],
  };
}

function itemValue(item, key, alternate) {
  return valueOf(item, key, alternate);
}

function normalizeItem(item, companyKey) {
  const itemCode = stringOrEmpty(itemValue(item, 'itemCode', 'item_code'));
  const description = stringOrEmpty(itemValue(item, 'description'));
  const uom = stringOrEmpty(itemValue(item, 'uom', 'UOM'));
  const quantity = itemValue(item, 'quantity');
  if (!COMPANY_KEYS.includes(companyKey) || !itemCode || !uom || typeof quantity !== 'string') {
    const error = new TypeError('invalid persisted loading item snapshot');
    error.code = 'invalid_snapshot_item';
    throw error;
  }
  parseDecimal(quantity);
  return { itemCode, description, uom, quantity };
}

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function buildLoadingSheet(trip) {
  if (!trip || typeof trip !== 'object') return null;
  const rawAssignments = Array.isArray(trip.assignments) ? trip.assignments : [];
  const assignments = rawAssignments
    .map((assignment) => ({ assignment, invoice: safeInvoice(assignment) }))
    .filter(({ invoice }) => invoice.status !== 'removed');
  const totals = new Map();
  for (const { invoice } of assignments) {
    for (const rawItem of invoice.items) {
      const item = normalizeItem(rawItem, invoice.companyKey);
      const key = `${item.itemCode}\u0000${item.uom}`;
      const existing = totals.get(key) || {
        itemCode: item.itemCode,
        description: item.description,
        uom: item.uom,
        enterprise: '0',
        sdn_bhd: '0',
      };
      existing[invoice.companyKey] = addDecimalStrings(existing[invoice.companyKey], item.quantity);
      totals.set(key, existing);
    }
  }

  const items = [...totals.values()]
    .map((item) => ({ ...item, total: addDecimalStrings(item.enterprise, item.sdn_bhd) }))
    .sort((left, right) => compareText(left.itemCode, right.itemCode) || compareText(left.uom, right.uom));
  const invoices = assignments.map(({ invoice }) => ({
    companyKey: invoice.companyKey,
    companyName: invoice.companyName,
    invoiceId: invoice.invoiceId,
    docNo: invoice.docNo,
    docDate: invoice.docDate,
    customer: invoice.customer,
    status: invoice.status,
    assignedAt: invoice.assignedAt,
    updatedAt: invoice.updatedAt,
  }));
  const counts = invoices.reduce((result, invoice) => {
    if (result[invoice.companyKey] !== undefined) result[invoice.companyKey] += 1;
    result.total += 1;
    return result;
  }, { enterprise: 0, sdn_bhd: 0, total: 0 });
  const routeNotes = stringOrEmpty(valueOf(trip, 'routeNotes', 'route_notes'));

  return {
    trip: {
      id: valueOf(trip, 'id', 'tripId', 'trip_id'),
      tripDate: stringOrEmpty(valueOf(trip, 'tripDate', 'trip_date')),
      status: stringOrEmpty(valueOf(trip, 'status')),
      routeNotes,
      driver: safeDriver(trip),
      lorry: safeLorry(trip),
    },
    counts,
    items,
    invoices,
  };
}

async function loadLoadingSheet(repository, tripId) {
  if (!repository || typeof repository !== 'object') throw new TypeError('a dispatch repository is required');
  let trip;
  if (typeof repository.getTripDetails === 'function') {
    trip = await repository.getTripDetails(tripId);
  } else if (typeof repository.getTrip === 'function') {
    trip = await repository.getTrip(tripId);
  } else {
    throw new TypeError('the repository cannot read trips');
  }
  if (!trip) return null;
  if (!Array.isArray(trip.assignments) && typeof repository.listAssignments === 'function') {
    trip = { ...trip, assignments: await repository.listAssignments({ tripId, limit: 100 }) };
  }
  return buildLoadingSheet(trip);
}

module.exports = {
  COMPANY_KEYS,
  COMPANY_NAMES,
  addDecimalStrings,
  buildLoadingSheet,
  loadLoadingSheet,
  parseDecimal,
};
