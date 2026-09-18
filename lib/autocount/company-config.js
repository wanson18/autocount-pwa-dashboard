const COMPANY_DEFINITIONS = Object.freeze({
  enterprise: Object.freeze({
    companyKey: 'enterprise',
    name: 'Wanson Enterprise',
    accountBookEnv: 'AUTOCOUNT_ACCOUNT_BOOK_WANSON_ENTERPRISE',
    keyIdEnv: 'AUTOCOUNT_KEY_ID_WANSON_ENTERPRISE',
    apiKeyEnv: 'AUTOCOUNT_API_KEY_WANSON_ENTERPRISE',
    keyIdAliases: ['AUTOCOUNT_ENTERPRISE_KEY_ID'],
    apiKeyAliases: ['AUTOCOUNT_ENTERPRISE_API_KEY'],
  }),
  sdn_bhd: Object.freeze({
    companyKey: 'sdn_bhd',
    name: 'Wanson Enterprise (M) Sdn Bhd',
    accountBookEnv: 'AUTOCOUNT_ACCOUNT_BOOK_WANSON_SDN_BHD',
    keyIdEnv: 'AUTOCOUNT_KEY_ID_WANSON_SDN_BHD',
    apiKeyEnv: 'AUTOCOUNT_API_KEY_WANSON_SDN_BHD',
    keyIdAliases: ['AUTOCOUNT_SDN_BHD_KEY_ID'],
    apiKeyAliases: ['AUTOCOUNT_SDN_BHD_API_KEY'],
  }),
});

class CompanyConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CompanyConfigError';
  }
}

function value(env, key) {
  return typeof env[key] === 'string' ? env[key].trim() : '';
}

function firstConfigured(env, names) {
  for (const name of names) {
    const configured = value(env, name);
    if (configured) return configured;
  }
  return '';
}

function credentialsFor(definition, env) {
  const companyKeyId = firstConfigured(env, [definition.keyIdEnv, ...(definition.keyIdAliases || [])]);
  const companyApiKey = firstConfigured(env, [definition.apiKeyEnv, ...(definition.apiKeyAliases || [])]);
  if (Boolean(companyKeyId) !== Boolean(companyApiKey)) {
    throw new CompanyConfigError(
      `${definition.keyIdEnv} and ${definition.apiKeyEnv} must be set together`,
    );
  }
  if (companyKeyId) return { keyId: companyKeyId, apiKey: companyApiKey };

  const sharedKeyId = value(env, 'AUTOCOUNT_API_KEY_ID') || value(env, 'AUTOCOUNT_KEY_ID');
  const sharedApiKey = value(env, 'AUTOCOUNT_API_KEY');
  if (Boolean(sharedKeyId) !== Boolean(sharedApiKey)) {
    throw new CompanyConfigError('shared AutoCount credentials require both key ID and API key');
  }
  if (!sharedKeyId) {
    throw new CompanyConfigError(`missing credentials for ${definition.companyKey}`);
  }
  return { keyId: sharedKeyId, apiKey: sharedApiKey };
}

function loadCompanyConfigs(env = process.env) {
  const configs = {};
  for (const definition of Object.values(COMPANY_DEFINITIONS)) {
    const accountBookId = value(env, definition.accountBookEnv);
    if (!accountBookId) {
      throw new CompanyConfigError(`missing ${definition.accountBookEnv}`);
    }
    configs[definition.companyKey] = {
      companyKey: definition.companyKey,
      name: definition.name,
      accountBookId,
      ...credentialsFor(definition, env),
    };
  }
  if (configs.enterprise.accountBookId === configs.sdn_bhd.accountBookId) {
    throw new CompanyConfigError('company account books must be distinct');
  }
  return Object.freeze(configs);
}

function publicCompany(config) {
  return { companyKey: config.companyKey, name: config.name };
}

module.exports = {
  COMPANY_DEFINITIONS,
  CompanyConfigError,
  loadCompanyConfigs,
  publicCompany,
};
