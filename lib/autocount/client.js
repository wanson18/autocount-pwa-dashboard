const axios = require('axios');

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
      },
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error('AutoCount invoice listing request failed');
    }
    return response.data;
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
      },
    );
    return response.data;
  }

}

module.exports = { AutoCountClient };
