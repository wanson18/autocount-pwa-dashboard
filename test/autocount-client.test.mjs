import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import clientModule from '../lib/autocount/client.js';

const { AutoCountClient } = clientModule;

const RAW = '{"data":[{"master":{"docKey":12345678901234567890,"docNo":"INV-1","cancelled":false,"note":null},"details":[{"qty":3.000,"unitPrice":-2.50,"subTotal":1e400}]}],"totalCount":1,"pageSize":100}';

function serve(body) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      requests.push({ url: req.url, headers: req.headers });
      res.setHeader('Content-Type', 'application/json');
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, requests, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test('through real axios, AutoCount numbers arrive as their exact text and totalCount as a number', async () => {
  const { server, requests, base } = await serve(RAW);
  try {
    const client = new AutoCountClient({ baseUrl: base });
    const page = await client.listInvoicePage(
      { accountBookId: '63750', apiKey: 'k', keyId: 'i' },
      { page: 1, startDate: '2026-10-15', endDate: '2026-10-15' },
    );
    const master = page.data[0].master;
    const line = page.data[0].details[0];

    assert.equal(master.docKey, '12345678901234567890');
    assert.equal(line.qty, '3.000');
    assert.equal(line.unitPrice, '-2.50');
    assert.equal(line.subTotal, '1e400');
    assert.equal(page.totalCount, 1);
    assert.equal(typeof page.totalCount, 'number');
    assert.equal(page.pageSize, '100');
    assert.equal(master.docNo, 'INV-1');
    assert.equal(master.cancelled, false);
    assert.equal(master.note, null);
    assert.equal(requests[0].url, '/63750/invoice/listing?page=1&startDate=2026-10-15&endDate=2026-10-15');
    assert.equal(requests[0].headers['api-key'], 'k');
    assert.equal(requests[0].headers['key-id'], 'i');
    assert.equal(requests[0].headers['content-type'], undefined);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test('every client request asks axios for the raw text, so axios never runs JSON.parse', async () => {
  const transforms = [];
  const fake = {
    async get(url, options) {
      transforms.push(options.transformResponse);
      return { status: 200, data: '{"data":[],"totalCount":0}' };
    },
  };
  const client = new AutoCountClient({ baseUrl: 'https://cloud.example', http: fake });
  const company = { accountBookId: '63750', apiKey: 'k', keyId: 'i' };

  await client.listInvoicePage(company, { page: 1, startDate: '2026-10-15', endDate: '2026-10-15' });
  await client.getCompanyProfile(company);
  await client.getProduct(company, 'ITEM-A');

  assert.equal(transforms.length, 3);
  for (const transform of transforms) {
    assert.ok(Array.isArray(transform) && transform.length === 1);
    assert.equal(transform[0]('{"a":1.10}'), '{"a":1.10}');
  }
});

test('requests go to the company address when its settings gave one, else to the client address', async () => {
  const urls = [];
  const fake = {
    async get(url) {
      urls.push(url);
      return { status: 200, data: '{"data":[],"totalCount":0}' };
    },
  };
  const client = new AutoCountClient({ baseUrl: 'https://cloud.example///', http: fake });
  const params = { page: 1, startDate: '2026-10-15', endDate: '2026-10-15' };

  await client.listInvoicePage({ accountBookId: '63750', apiKey: 'k', keyId: 'i' }, params);
  await client.listInvoicePage({ accountBookId: '63688', apiKey: 'k', keyId: 'i', apiUrl: ' https://sdn.example// ' }, params);
  await client.getProduct({ accountBookId: '63688', apiKey: 'k', keyId: 'i', apiUrl: 'https://sdn.example' }, 'ITEM-A');
  await client.getCompanyProfile({ accountBookId: '63750', apiKey: 'k', keyId: 'i', apiUrl: '' });

  assert.deepEqual(urls, [
    'https://cloud.example/63750/invoice/listing',
    'https://sdn.example/63688/invoice/listing',
    'https://sdn.example/63688/product',
    'https://cloud.example/63750/companyProfile',
  ]);
});
