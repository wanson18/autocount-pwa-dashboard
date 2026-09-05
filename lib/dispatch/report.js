const COMPANY_KEYS = new Set(['enterprise', 'sdn_bhd']);
const COMPANY_NAMES = Object.freeze({
  enterprise: 'Wanson Enterprise',
  sdn_bhd: 'Wanson Enterprise (M) Sdn Bhd',
});
const TRIP_STATUSES = new Set(['planned', 'loading', 'dispatched', 'completed', 'cancelled']);
const ASSIGNMENT_STATUSES = new Set([
  'assigned', 'loaded', 'out_for_delivery', 'delivered', 'failed', 'returned', 'removed',
]);
const REPORT_COLUMNS = Object.freeze([
  'trip_id', 'trip_date', 'trip_status', 'driver_id', 'driver_name', 'lorry_id',
  'lorry_registration', 'route', 'company', 'invoice_id', 'invoice_no', 'invoice_date',
  'customer_code', 'customer_name', 'assignment_status', 'assigned_at', 'updated_at',
]);

function valueOf(value, ...keys) {
  for (const key of keys) {
    if (value?.[key] !== undefined && value?.[key] !== null) return value[key];
  }
  return undefined;
}

function objectOf(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value) {
  return value === undefined || value === null ? '' : String(value);
}

function timestamp(value) {
  if (value instanceof Date) return value.toISOString();
  return value === undefined || value === null ? '' : String(value);
}

function customerOf(row, header) {
  const customer = objectOf(valueOf(row, 'customer') ?? valueOf(header, 'customer'));
  return {
    code: text(valueOf(customer, 'code', 'customerCode', 'customer_code')),
    name: text(valueOf(customer, 'name', 'customerName', 'customer_name')),
  };
}

function driverOf(row, trip) {
  const driver = objectOf(valueOf(row, 'driver') ?? valueOf(trip, 'driver'));
  return {
    id: valueOf(driver, 'id') ?? valueOf(row, 'driverId', 'driver_id') ?? valueOf(trip, 'driverId', 'driver_id') ?? null,
    name: text(valueOf(driver, 'name') ?? valueOf(row, 'driverName', 'driver_name')),
    licenseNo: text(valueOf(driver, 'licenseNo', 'license_no') ?? valueOf(row, 'driverLicenseNo', 'driver_license_no')),
  };
}

function lorryOf(row, trip) {
  const lorry = objectOf(valueOf(row, 'lorry') ?? valueOf(row, 'vehicle') ?? valueOf(trip, 'lorry') ?? valueOf(trip, 'vehicle'));
  return {
    id: valueOf(lorry, 'id') ?? valueOf(row, 'vehicleId', 'vehicle_id') ?? valueOf(trip, 'vehicleId', 'vehicle_id') ?? null,
    registrationNo: text(valueOf(lorry, 'registrationNo', 'registration_no') ?? valueOf(row, 'vehicleRegistrationNo', 'vehicle_registration_no')),
    description: text(valueOf(lorry, 'description') ?? valueOf(row, 'vehicleDescription', 'vehicle_description')),
  };
}

function normalizeReportRecord(row) {
  const source = objectOf(row);
  const trip = objectOf(source.trip);
  const header = objectOf(source.header ?? source.invoiceHeader ?? source.invoice_header);
  const companyKey = valueOf(source, 'companyKey', 'company_key') ?? valueOf(header, 'companyKey', 'company_key');
  const driver = driverOf(source, trip);
  const lorry = lorryOf(source, trip);
  const customer = customerOf(source, header);
  const tripStatus = text(valueOf(source, 'tripStatus', 'trip_status') ?? valueOf(trip, 'status'));
  const assignmentStatus = text(valueOf(source, 'assignmentStatus', 'assignment_status', 'status'));
  const route = text(valueOf(source, 'route', 'routeNotes', 'route_notes') ?? valueOf(trip, 'routeNotes', 'route_notes'));
  return {
    assignmentId: valueOf(source, 'assignmentId', 'assignment_id', 'id') ?? null,
    tripId: valueOf(source, 'tripId', 'trip_id') ?? valueOf(trip, 'id', 'tripId', 'trip_id') ?? null,
    tripDate: text(valueOf(source, 'tripDate', 'trip_date') ?? valueOf(trip, 'tripDate', 'trip_date')),
    tripStatus,
    driver,
    lorry,
    route,
    companyKey,
    companyName: COMPANY_NAMES[companyKey] || companyKey,
    invoiceId: text(valueOf(source, 'invoiceId', 'invoice_id') ?? valueOf(header, 'invoiceId', 'invoice_id', 'docKey', 'doc_key')),
    docNo: text(valueOf(source, 'docNo', 'doc_no') ?? valueOf(header, 'docNo', 'doc_no')),
    docDate: text(valueOf(source, 'docDate', 'doc_date') ?? valueOf(header, 'docDate', 'doc_date')),
    customer,
    assignmentStatus,
    assignedAt: timestamp(valueOf(source, 'assignedAt', 'assigned_at')),
    updatedAt: timestamp(valueOf(source, 'updatedAt', 'updated_at')),
  };
}

function compareRecords(left, right) {
  return text(left.tripDate).localeCompare(text(right.tripDate))
    || text(left.tripId).localeCompare(text(right.tripId), undefined, { numeric: true })
    || text(left.assignmentId).localeCompare(text(right.assignmentId), undefined, { numeric: true });
}

function dateInRange(value, startDate, endDate) {
  if (!startDate || !endDate) return true;
  return value >= startDate && value <= endDate;
}

function matchesStatus(record, status) {
  if (!status) return true;
  return record.tripStatus === status || record.assignmentStatus === status;
}

function matchesId(value, expected) {
  return expected === null || expected === undefined ? true : String(value) === String(expected);
}

function filterReportRecords(records, filters = {}) {
  const company = filters.company ?? filters.companyKey ?? 'all';
  const driverId = filters.driverId ?? filters.driver_id ?? null;
  const vehicleId = filters.vehicleId ?? filters.vehicle_id ?? filters.lorryId ?? filters.lorry_id ?? null;
  const status = filters.status ?? null;
  return records
    .map(normalizeReportRecord)
    .filter((record) => dateInRange(record.tripDate, filters.startDate, filters.endDate))
    .filter((record) => company === 'all' || record.companyKey === company)
    .filter((record) => matchesId(record.driver.id, driverId))
    .filter((record) => matchesId(record.lorry.id, vehicleId))
    .filter((record) => matchesStatus(record, status))
    .sort(compareRecords);
}

function buildReport(records, filters = {}) {
  const normalizedFilters = {
    startDate: filters.startDate ?? null,
    endDate: filters.endDate ?? null,
    company: filters.company ?? 'all',
    driverId: filters.driverId ?? null,
    vehicleId: filters.vehicleId ?? null,
    status: filters.status ?? null,
  };
  return {
    startDate: normalizedFilters.startDate,
    endDate: normalizedFilters.endDate,
    company: normalizedFilters.company,
    records: filterReportRecords(Array.isArray(records) ? records : [], normalizedFilters),
  };
}

function neutralizeSpreadsheetFormula(value) {
  const stringValue = text(value);
  return /^[\t \r\n]*[=+\-@]/.test(stringValue) ? `'${stringValue}` : stringValue;
}

function csvCell(value) {
  const safeValue = neutralizeSpreadsheetFormula(value);
  return /[",\r\n]/.test(safeValue) ? `"${safeValue.replaceAll('"', '""')}"` : safeValue;
}

function reportToCsv(reportOrRecords) {
  const records = Array.isArray(reportOrRecords)
    ? reportOrRecords.map(normalizeReportRecord).sort(compareRecords)
    : (reportOrRecords?.records || []).map(normalizeReportRecord).sort(compareRecords);
  const rows = [REPORT_COLUMNS.join(',')];
  for (const record of records) {
    rows.push([
      record.tripId,
      record.tripDate,
      record.tripStatus,
      record.driver.id,
      record.driver.name,
      record.lorry.id,
      record.lorry.registrationNo,
      record.route,
      record.companyKey,
      record.invoiceId,
      record.docNo,
      record.docDate,
      record.customer.code,
      record.customer.name,
      record.assignmentStatus,
      record.assignedAt,
      record.updatedAt,
    ].map(csvCell).join(','));
  }
  return `${rows.join('\r\n')}\r\n`;
}

function dateOnlyAtKualaLumpur(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T00:00:00+08:00`);
  }
  return value instanceof Date ? value : new Date(value);
}

const DATE_FORMATTER = new Intl.DateTimeFormat('en-MY', {
  timeZone: 'Asia/Kuala_Lumpur', day: '2-digit', month: 'short', year: 'numeric',
});
const DATE_TIME_FORMATTER = new Intl.DateTimeFormat('en-MY', {
  timeZone: 'Asia/Kuala_Lumpur', day: '2-digit', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function formatKualaLumpurDate(value) {
  const date = dateOnlyAtKualaLumpur(value);
  return Number.isNaN(date.getTime()) ? '' : DATE_FORMATTER.format(date);
}

function formatKualaLumpurDateTime(value) {
  const date = dateOnlyAtKualaLumpur(value);
  return Number.isNaN(date.getTime()) ? '' : DATE_TIME_FORMATTER.format(date);
}

module.exports = {
  ASSIGNMENT_STATUSES,
  COMPANY_NAMES,
  REPORT_COLUMNS,
  TRIP_STATUSES,
  buildReport,
  filterReportRecords,
  formatKualaLumpurDate,
  formatKualaLumpurDateTime,
  normalizeReportRecord,
  reportToCsv,
  neutralizeSpreadsheetFormula,
};
