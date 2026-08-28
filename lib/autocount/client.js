const axios = require('axios');
const losslessJson = require('lossless-json');

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

class AutoCountClient {
  constructor({ baseUrl, http = axios } = {}) {
    this.baseUrl = (baseUrl || process.env.AUTOCOUNT_API_URL || 'https://accounting-api.autocountcloud.com').replace(/\/$/, '');
    this.http = http;
  }

  async listInvoicePage(company, { page, startDate, endDate }) {
    const response = await this.http.get(
      `${this.baseUrl}/${encodeURIComponent(company.accountBookId)}/invoice/listing`,
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

  async getProduct(company, itemCode) {
    const response = await this.http.get(
      `${this.baseUrl}/${encodeURIComponent(company.accountBookId)}/product`,
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
