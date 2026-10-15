const axios = require('axios');
const losslessJson = require('lossless-json');
const { DEFAULT_API_URL } = require('./company-config');

function parseResponseData(data) {
  if (typeof data !== 'string') return data;
  try {
    return materializeResponse(losslessJson.parse(data));
  } catch (error) {
    const parseError = new Error('AutoCount returned invalid JSON');
    parseError.code = 'invalid_source_data';
    throw parseError;
  }
}

function materializeResponse(value, key = '') {
  if (losslessJson.isLosslessNumber(value)) {
    if (key === 'qty') return value.toString();
    if (key === 'totalCount') return Number(value.toString());
    return value.toString();
  }
  if (Array.isArray(value)) return value.map((entry) => materializeResponse(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      materializeResponse(entryValue, entryKey),
    ]));
  }
  return value;
}

function trimSlashes(url) {
  return url.replace(/\/+$/, '');
}

class AutoCountClient {
  constructor({ baseUrl, http = axios } = {}) {
    this.baseUrl = trimSlashes(baseUrl || process.env.AUTOCOUNT_API_URL || DEFAULT_API_URL);
    this.http = http;
  }

  // The company's own address when its settings gave one, else the client's.
  urlFor(company, pathname) {
    const own = typeof company?.apiUrl === 'string' ? company.apiUrl.trim() : '';
    const base = own ? trimSlashes(own) : this.baseUrl;
    return `${base}/${encodeURIComponent(company.accountBookId)}${pathname}`;
  }

  async listInvoicePage(company, { page, startDate, endDate }) {
    const response = await this.http.get(
      this.urlFor(company, '/invoice/listing'),
      {
        headers: {
          'API-Key': company.apiKey,
          'Key-ID': company.keyId,
        },
        params: { page, startDate, endDate },
        timeout: 15000,
        transformResponse: [(data) => data],
      },
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error('AutoCount invoice listing request failed');
    }
    return parseResponseData(response.data);
  }

  async getCompanyProfile(company) {
    const response = await this.http.get(
      this.urlFor(company, '/companyProfile'),
      {
        headers: {
          'API-Key': company.apiKey,
          'Key-ID': company.keyId,
        },
        timeout: 15000,
        transformResponse: [(data) => data],
      },
    );
    if (response.status !== 200) throw new Error('Cloud profile request failed');
    return parseResponseData(response.data);
  }

  async getProduct(company, itemCode) {
    const response = await this.http.get(
      this.urlFor(company, '/product'),
      {
        headers: {
          'API-Key': company.apiKey,
          'Key-ID': company.keyId,
        },
        params: { code: itemCode },
        timeout: 15000,
        transformResponse: [(data) => data],
      },
    );
    return parseResponseData(response.data);
  }
}

module.exports = { AutoCountClient };
