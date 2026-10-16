import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../lib/autocount/company-config.js';
import source from '../lib/price-check/source.js';

const { COMPANIES, CompanyConfigError, loadCompanyConfigs, readCompanySettings } = config;

const OWN = {
  AUTOCOUNT_ENTERPRISE_API_KEY: 'ent-key',
  AUTOCOUNT_ENTERPRISE_KEY_ID: 'ent-id',
  AUTOCOUNT_SDN_BHD_API_KEY: 'sdn-key',
  AUTOCOUNT_SDN_BHD_KEY_ID: 'sdn-id',
};

const byKey = (settings) => Object.fromEntries(settings.map((entry) => [entry.companyKey, entry]));

test('the two books are fixed in code, with every name each surface shows', () => {
  assert.deepEqual(COMPANIES.map((company) => ({ ...company })), [
    { companyKey: 'enterprise', salesId: 'enterprise', accountBookId: '63750', name: 'Wanson Enterprise', dashboardName: 'Wanson Enterprise', profileName: 'WANSON ENTERPRISE' },
    { companyKey: 'sdn_bhd', salesId: 'sdnBhd', accountBookId: '63688', name: 'Wanson Enterprise (M) Sdn Bhd', dashboardName: 'Wanson Sdn Bhd', profileName: 'WANSON ENTERPRISE (M) SDN. BHD' },
  ]);
  assert.ok(Object.isFrozen(COMPANIES) && COMPANIES.every((company) => Object.isFrozen(company)));
});

test('own names are read first, the WANSON aliases second', () => {
  const settings = byKey(readCompanySettings({
    ...OWN,
    AUTOCOUNT_API_KEY_WANSON_ENTERPRISE: 'alias-ent-key',
    AUTOCOUNT_KEY_ID_WANSON_ENTERPRISE: 'alias-ent-id',
    AUTOCOUNT_API_KEY_WANSON_SDN_BHD: 'alias-sdn-key',
    AUTOCOUNT_KEY_ID_WANSON_SDN_BHD: 'alias-sdn-id',
  }));
  assert.deepEqual([settings.enterprise.apiKey, settings.enterprise.keyId], ['ent-key', 'ent-id']);
  assert.deepEqual([settings.sdn_bhd.apiKey, settings.sdn_bhd.keyId], ['sdn-key', 'sdn-id']);
});

test('the aliases alone are enough, and the two own-name styles may be mixed', () => {
  const settings = byKey(readCompanySettings({
    AUTOCOUNT_API_KEY_WANSON_ENTERPRISE: 'alias-ent-key',
    AUTOCOUNT_ENTERPRISE_KEY_ID: 'ent-id',
    AUTOCOUNT_SDN_BHD_API_KEY: 'sdn-key',
    AUTOCOUNT_KEY_ID_WANSON_SDN_BHD: 'alias-sdn-id',
  }));
  assert.deepEqual([settings.enterprise.apiKey, settings.enterprise.keyId, settings.enterprise.problem], ['alias-ent-key', 'ent-id', null]);
  assert.deepEqual([settings.sdn_bhd.apiKey, settings.sdn_bhd.keyId, settings.sdn_bhd.problem], ['sdn-key', 'alias-sdn-id', null]);
});

test('half of an own pair makes the book misconfigured and never borrows the shared half', () => {
  const settings = byKey(readCompanySettings({
    AUTOCOUNT_ENTERPRISE_API_KEY: 'ent-key',
    AUTOCOUNT_KEY_ID: 'shared-id',
    AUTOCOUNT_API_KEY: 'shared-key',
    AUTOCOUNT_SDN_BHD_KEY_ID: 'sdn-id',
  }));
  assert.equal(settings.enterprise.problem.code, 'credentials_incomplete');
  assert.equal(settings.sdn_bhd.problem.code, 'credentials_incomplete');
  assert.equal(settings.enterprise.apiKey, null);
  assert.equal(settings.enterprise.keyId, null);
});

test('Enterprise may use the complete shared pair when none of its own names is set', () => {
  const withKeyId = byKey(readCompanySettings({ AUTOCOUNT_API_KEY: 'shared-key', AUTOCOUNT_KEY_ID: 'shared-id', AUTOCOUNT_SDN_BHD_API_KEY: 'sdn-key', AUTOCOUNT_SDN_BHD_KEY_ID: 'sdn-id' }));
  assert.deepEqual([withKeyId.enterprise.apiKey, withKeyId.enterprise.keyId, withKeyId.enterprise.problem], ['shared-key', 'shared-id', null]);

  const withApiKeyId = byKey(readCompanySettings({ AUTOCOUNT_API_KEY: 'shared-key', AUTOCOUNT_API_KEY_ID: 'other-id' }));
  assert.equal(withApiKeyId.enterprise.keyId, 'other-id');

  const both = byKey(readCompanySettings({ AUTOCOUNT_API_KEY: 'shared-key', AUTOCOUNT_KEY_ID: 'shared-id', AUTOCOUNT_API_KEY_ID: 'other-id' }));
  assert.equal(both.enterprise.keyId, 'shared-id', 'AUTOCOUNT_KEY_ID comes before AUTOCOUNT_API_KEY_ID');
});

test('an incomplete shared pair is refused for Enterprise', () => {
  for (const env of [{ AUTOCOUNT_API_KEY: 'shared-key' }, { AUTOCOUNT_KEY_ID: 'shared-id' }, { AUTOCOUNT_API_KEY_ID: 'shared-id' }]) {
    const settings = byKey(readCompanySettings(env));
    assert.equal(settings.enterprise.problem.code, 'shared_credentials_incomplete');
    assert.match(settings.enterprise.problem.message, /shared AutoCount credentials/);
  }
});

test('Sdn Bhd never uses the shared pair', () => {
  const settings = byKey(readCompanySettings({ AUTOCOUNT_API_KEY: 'shared-key', AUTOCOUNT_KEY_ID: 'shared-id' }));
  assert.equal(settings.enterprise.problem, null);
  assert.equal(settings.sdn_bhd.problem.code, 'credentials_missing');
  assert.equal(settings.sdn_bhd.apiKey, null);
  assert.equal(settings.sdn_bhd.keyId, null);
});

test('a book number setting is optional, and must match the fixed book when set', () => {
  assert.equal(byKey(readCompanySettings(OWN)).enterprise.problem, null);

  const equal = byKey(readCompanySettings({ ...OWN, AUTOCOUNT_ACCOUNT_BOOK_WANSON_ENTERPRISE: ' 63750 ', AUTOCOUNT_ACCOUNT_BOOK_WANSON_SDN_BHD: '63688' }));
  assert.equal(equal.enterprise.problem, null);
  assert.equal(equal.sdn_bhd.problem, null);

  const different = byKey(readCompanySettings({ ...OWN, AUTOCOUNT_ACCOUNT_BOOK_WANSON_SDN_BHD: '63750' }));
  assert.equal(different.sdn_bhd.problem.code, 'account_book_mismatch');
  assert.equal(different.sdn_bhd.accountBookId, '63688', 'the fixed book is never replaced');
  assert.equal(different.sdn_bhd.apiKey, null);
  assert.equal(different.enterprise.problem, null);
});

test('values are trimmed and blank values count as unset', () => {
  const settings = byKey(readCompanySettings({
    AUTOCOUNT_ENTERPRISE_API_KEY: '  ',
    AUTOCOUNT_API_KEY_WANSON_ENTERPRISE: ' ent-key\n',
    AUTOCOUNT_ENTERPRISE_KEY_ID: '\tent-id ',
    AUTOCOUNT_SDN_BHD_API_KEY: 'sdn-key',
    AUTOCOUNT_SDN_BHD_KEY_ID: 'sdn-id',
    AUTOCOUNT_ACCOUNT_BOOK_WANSON_ENTERPRISE: '',
  }));
  assert.deepEqual([settings.enterprise.apiKey, settings.enterprise.keyId, settings.enterprise.problem], ['ent-key', 'ent-id', null]);
});

test('the address comes from the per-company setting, then AUTOCOUNT_API_URL, then the default', () => {
  const defaults = byKey(readCompanySettings(OWN));
  assert.equal(defaults.enterprise.apiUrl, 'https://accounting-api.autocountcloud.com');

  const shared = byKey(readCompanySettings({ ...OWN, AUTOCOUNT_API_URL: 'https://cloud.example//' }));
  assert.equal(shared.enterprise.apiUrl, 'https://cloud.example');
  assert.equal(shared.sdn_bhd.apiUrl, 'https://cloud.example');

  const perCompany = byKey(readCompanySettings({ ...OWN, AUTOCOUNT_API_URL: 'https://cloud.example', AUTOCOUNT_SDN_BHD_API_URL: ' https://sdn.example/ ' }));
  assert.equal(perCompany.enterprise.apiUrl, 'https://cloud.example');
  assert.equal(perCompany.sdn_bhd.apiUrl, 'https://sdn.example');
});

test('AUTOCOUNT_ENTERPRISE_API_URL is for Enterprise only, and a blank per-book address falls through', () => {
  const enterpriseOnly = byKey(readCompanySettings({ ...OWN, AUTOCOUNT_API_URL: 'https://cloud.example', AUTOCOUNT_ENTERPRISE_API_URL: ' https://enterprise.example/ ' }));
  assert.equal(enterpriseOnly.enterprise.apiUrl, 'https://enterprise.example');
  assert.equal(enterpriseOnly.sdn_bhd.apiUrl, 'https://cloud.example');

  const both = byKey(readCompanySettings({ ...OWN, AUTOCOUNT_ENTERPRISE_API_URL: 'https://enterprise.example', AUTOCOUNT_SDN_BHD_API_URL: 'https://sdn.example' }));
  assert.deepEqual([both.enterprise.apiUrl, both.sdn_bhd.apiUrl], ['https://enterprise.example', 'https://sdn.example']);

  const blankToShared = byKey(readCompanySettings({ ...OWN, AUTOCOUNT_API_URL: 'https://cloud.example', AUTOCOUNT_ENTERPRISE_API_URL: '  ', AUTOCOUNT_SDN_BHD_API_URL: '' }));
  assert.deepEqual([blankToShared.enterprise.apiUrl, blankToShared.sdn_bhd.apiUrl], ['https://cloud.example', 'https://cloud.example']);

  const blankToDefault = byKey(readCompanySettings({ ...OWN, AUTOCOUNT_API_URL: ' ', AUTOCOUNT_ENTERPRISE_API_URL: '', AUTOCOUNT_SDN_BHD_API_URL: '\t' }));
  assert.deepEqual(
    [blankToDefault.enterprise.apiUrl, blankToDefault.sdn_bhd.apiUrl],
    ['https://accounting-api.autocountcloud.com', 'https://accounting-api.autocountcloud.com'],
  );
});

test('problem messages name settings but never contain a value', () => {
  const secrets = {
    AUTOCOUNT_ENTERPRISE_API_KEY: 'secret-ent-key',
    AUTOCOUNT_SDN_BHD_KEY_ID: 'secret-sdn-id',
    AUTOCOUNT_API_KEY: 'secret-shared-key',
    AUTOCOUNT_ACCOUNT_BOOK_WANSON_ENTERPRISE: 'secret-book',
  };
  const messages = readCompanySettings(secrets).map((entry) => entry.problem?.message || '').join(' | ');
  assert.ok(messages.includes('AUTOCOUNT_'), 'messages name the settings');
  for (const secret of Object.values(secrets)) assert.equal(messages.includes(secret), false, secret);
});

test('loadCompanyConfigs keeps its contract for Dispatch and Price Check', () => {
  const configs = loadCompanyConfigs(OWN);
  assert.deepEqual(Object.keys(configs), ['enterprise', 'sdn_bhd']);
  assert.deepEqual({ ...configs.enterprise }, {
    companyKey: 'enterprise',
    name: 'Wanson Enterprise',
    accountBookId: '63750',
    apiUrl: 'https://accounting-api.autocountcloud.com',
    keyId: 'ent-id',
    apiKey: 'ent-key',
  });
  assert.equal(configs.sdn_bhd.name, 'Wanson Enterprise (M) Sdn Bhd');
  assert.ok(Object.isFrozen(configs));
  assert.throws(
    () => loadCompanyConfigs({ AUTOCOUNT_ENTERPRISE_API_KEY: 'ent-key', AUTOCOUNT_ENTERPRISE_KEY_ID: 'ent-id' }),
    (error) => error instanceof CompanyConfigError && /sdn_bhd/.test(error.message),
  );
});

test('Price Check checks the books against the shared list', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(source.COMPANY_REGISTRY)), {
    enterprise: { accountBookId: '63750', profileName: 'WANSON ENTERPRISE' },
    sdn_bhd: { accountBookId: '63688', profileName: 'WANSON ENTERPRISE (M) SDN. BHD' },
  });
});
