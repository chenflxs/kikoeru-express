const { createHash, timingSafeEqual } = require('crypto');

function validWritebackKey(key) {
  return typeof key === 'string' && key.length === 16 && /^[A-Za-z0-9]{16}$/.test(key);
}

function hashWritebackKey(key) {
  return createHash('sha256').update(key).digest('hex');
}

function getWritebackConfig(config) {
  if (config.kikoetaWritebackEnabled !== null) {
    const keyHash = config.kikoetaWritebackKeyHash;
    return {
      enabled: config.kikoetaWritebackEnabled === true,
      keyHash: typeof keyHash === 'string' && keyHash.length === 64 && /^[a-f0-9]{64}$/.test(keyHash) ? keyHash : '',
    };
  }
  // The first explicit save in the dashboard takes precedence over the old env settings.
  const key = process.env.KIKOERU_KIKOETA_WRITEBACK_KEY;
  return {
    enabled: process.env.KIKOERU_KIKOETA_WRITEBACK === '1' && validWritebackKey(key),
    keyHash: validWritebackKey(key) ? hashWritebackKey(key) : '',
  };
}

function matchesWritebackKey(key, keyHash) {
  return validWritebackKey(key)
    && timingSafeEqual(Buffer.from(keyHash, 'hex'), Buffer.from(hashWritebackKey(key), 'hex'));
}

module.exports = { getWritebackConfig, hashWritebackKey, matchesWritebackKey, validWritebackKey };
