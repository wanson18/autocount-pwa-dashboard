'use strict';

// The two AutoCount books and the one set of rules for reading their settings.
// Sales, Dispatch and Price Check all load company settings here, so a book can
// never be read with another book's credentials or a book number chosen
// elsewhere. Problem messages name settings, never their values.

const DEFAULT_API_URL = 'https://accounting-api.autocountcloud.com';

const COMPANIES = Object.freeze([
  Object.freeze({
    companyKey: 'enterprise',
    salesId: 'enterprise',
    accountBookId: '63750',
    name: 'Wanson Enterprise',
    dashboardName: 'Wanson Enterprise',
    profileName: 'WANSON ENTERPRISE',
  }),
  Object.freeze({
    companyKey: 'sdn_bhd',
    salesId: 'sdnBhd',
    accountBookId: '63688',
    name: 'Wanson Enterprise (M) Sdn Bhd',
    dashboardName: 'Wanson Sdn Bhd',
    profileName: 'WANSON ENTERPRISE (M) SDN. BHD',
  }),
]);

// Setting names in the order they are tried. Only Enterprise may fall back to
// the old shared pair, and only when none of its own names is set.
const SETTING_NAMES = Object.freeze({
  enterprise: Object.freeze({
    accountBook: 'AUTOCOUNT_ACCOUNT_BOOK_WANSON_ENTERPRISE',
    apiUrl: 'AUTOCOUNT_ENTERPRISE_API_URL',
    apiKey: Object.freeze(['AUTOCOUNT_ENTERPRISE_API_KEY', 'AUTOCOUNT_API_KEY_WANSON_ENTERPRISE']),
    keyId: Object.freeze(['AUTOCOUNT_ENTERPRISE_KEY_ID', 'AUTOCOUNT_KEY_ID_WANSON_ENTERPRISE']),
    shared: Object.freeze({
      apiKey: Object.freeze(['AUTOCOUNT_API_KEY']),
      keyId: Object.freeze(['AUTOCOUNT_KEY_ID', 'AUTOCOUNT_API_KEY_ID']),
    }),
  }),
  sdn_bhd: Object.freeze({
    accountBook: 'AUTOCOUNT_ACCOUNT_BOOK_WANSON_SDN_BHD',
    apiUrl: 'AUTOCOUNT_SDN_BHD_API_URL',
    apiKey: Object.freeze(['AUTOCOUNT_SDN_BHD_API_KEY', 'AUTOCOUNT_API_KEY_WANSON_SDN_BHD']),
    keyId: Object.freeze(['AUTOCOUNT_SDN_BHD_KEY_ID', 'AUTOCOUNT_KEY_ID_WANSON_SDN_BHD']),
    shared: null,
  }),
});

class CompanyConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CompanyConfigError';
  }
}

function value(env, name) {
  return typeof env[name] === 'string' ? env[name].trim() : '';
}

function firstSet(env, names) {
  for (const name of names) {
    const found = value(env, name);
    if (found) return found;
  }
  return '';
}

function settingsProblem(code, message) {
  return Object.freeze({ code, message });
}

function resolveCredentials(companyKey, names, env) {
  const apiKey = firstSet(env, names.apiKey);
  const keyId = firstSet(env, names.keyId);
  if (apiKey && keyId) return { apiKey, keyId, problem: null };
  if (apiKey || keyId) {
    return {
      problem: settingsProblem(
        'credentials_incomplete',
        `${names.apiKey.join('/')} and ${names.keyId.join('/')} must be set together for ${companyKey}`,
      ),
    };
  }
  if (!names.shared) {
    return { problem: settingsProblem('credentials_missing', `missing credentials for ${companyKey}`) };
  }
  const sharedApiKey = firstSet(env, names.shared.apiKey);
  const sharedKeyId = firstSet(env, names.shared.keyId);
  if (sharedApiKey && sharedKeyId) return { apiKey: sharedApiKey, keyId: sharedKeyId, problem: null };
  if (sharedApiKey || sharedKeyId) {
    return {
      problem: settingsProblem('shared_credentials_incomplete', 'shared AutoCount credentials require both key ID and API key'),
    };
  }
  return { problem: settingsProblem('credentials_missing', `missing credentials for ${companyKey}`) };
}

// Every book with its address, credentials and any settings problem. A book
// with a problem never carries half a credential further.
function readCompanySettings(env = process.env) {
  return Object.freeze(COMPANIES.map((company) => {
    const names = SETTING_NAMES[company.companyKey];
    const apiUrl = (value(env, names.apiUrl) || value(env, 'AUTOCOUNT_API_URL') || DEFAULT_API_URL).replace(/\/+$/, '');
    const credentials = resolveCredentials(company.companyKey, names, env);
    const configuredBook = value(env, names.accountBook);
    const problem = configuredBook && configuredBook !== company.accountBookId
      ? settingsProblem('account_book_mismatch', `${names.accountBook} does not match the fixed account book for ${company.companyKey}`)
      : credentials.problem;
    return Object.freeze({
      ...company,
      apiUrl,
      apiKey: problem ? null : credentials.apiKey,
      keyId: problem ? null : credentials.keyId,
      problem,
    });
  }));
}

// Dispatch and Price Check need both books; any settings problem refuses both.
function loadCompanyConfigs(env = process.env) {
  const settings = readCompanySettings(env);
  const failed = settings.find((entry) => entry.problem);
  if (failed) throw new CompanyConfigError(failed.problem.message);
  const configs = {};
  for (const entry of settings) {
    configs[entry.companyKey] = {
      companyKey: entry.companyKey,
      name: entry.name,
      accountBookId: entry.accountBookId,
      apiUrl: entry.apiUrl,
      keyId: entry.keyId,
      apiKey: entry.apiKey,
    };
  }
  return Object.freeze(configs);
}

function publicCompany(config) {
  return { companyKey: config.companyKey, name: config.name };
}

module.exports = {
  COMPANIES,
  CompanyConfigError,
  DEFAULT_API_URL,
  loadCompanyConfigs,
  publicCompany,
  readCompanySettings,
};
