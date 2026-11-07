const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const vm = require('vm');
const express = require('express');
const jwt = require('jsonwebtoken');
const knex = require('knex');
const { getWritebackConfig, hashWritebackKey } = require('../auth/kikoetaWriteback');

function loadSource(relative, overrides) {
  const filename = path.resolve(__dirname, '..', relative);
  const scope = {
    module: { exports: {} }, console, process,
    require: name => Object.prototype.hasOwnProperty.call(overrides, name) ? overrides[name]
      : require(name.startsWith('.') ? path.resolve(path.dirname(filename), name) : name),
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), scope, { filename });
  return scope.module.exports;
}

describe('Kikoeta writeback policies', function () {
  let root;
  let config;
  let database;
  let server;
  const key = 'ABcd1234EFgh5678';
  const lyric = '[00:01.230] 字幕\n';
  const route = 'media/kikoeta-lyrics';
  const claims = { issuer: 'http://kikoeru', audience: 'http://kikoeru/api' };

  beforeEach(async function () {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kikoeta-policy-'));
    await fs.promises.mkdir(path.join(root, 'RJ123456'));
    await fs.promises.writeFile(path.join(root, 'RJ123456', '01.mp3'), 'audio');
    config = {
      auth: true, production: false, jwtsecret: 'isolated-policy-test',
      rootFolders: [{ name: 'test', path: root }], databaseFolderDir: root,
      kikoetaWritebackEnabled: false, kikoetaWritebackKeyHash: '', kikoetaWritebackAuth: null,
    };
    database = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await database.schema.createTable('t_work', table => {
      table.integer('id').primary();
      table.string('root_folder');
      table.string('dir');
      table.string('lyric_status');
    });
    await database.schema.createTable('t_translate_task', table => table.integer('work_id'));
    await database('t_work').insert({ id: 123456, root_folder: 'test', dir: 'RJ123456', lyric_status: '' });
  });

  afterEach(async function () {
    if (server) await new Promise(resolve => server.close(resolve));
    server = null;
    await database.destroy();
    await fs.promises.rmdir(root, { recursive: true });
  });

  async function start() {
    if (server) await new Promise(resolve => server.close(resolve));
    const settings = { config, setConfig: next => Object.assign(config, next) };
    const db = loadSource('database/db.js', { '../config': settings, knex: () => database });
    const routes = express.Router();
    routes.use('/media', loadSource('routes/media.js', { '../config': settings, '../database/db': db }));
    routes.use('/config', loadSource('routes/config.js', { '../config': settings }));
    const app = express();
    app.use(express.json());
    loadSource('api.js', { './config': settings, './routes': routes, './auth/utils': claims })(app);
    app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
      res.status(err.status || 500).send({ error: err.message });
    });
    server = await new Promise(resolve => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
  }

  function request(method, endpoint, { body, role, suppliedKey, expired } = {}) {
    const headers = {};
    if (role) headers.Authorization = `Bearer ${jwt.sign({ name: role === 'administrator' ? 'admin' : 'user1', group: role }, config.jwtsecret, { ...claims, expiresIn: expired ? -1 : 60 })}`;
    if (suppliedKey !== undefined) headers['X-Kikoeru-Writeback-Key'] = suppliedKey;
    let content;
    if (body !== undefined) {
      content = typeof body === 'string' ? body : JSON.stringify(body);
      headers['Content-Type'] = typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json';
    }
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: `/api/${endpoint}`, method, headers }, res => {
        let data = '';
        res.setEncoding('utf8').on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data }));
      });
      req.on('error', reject);
      req.end(content);
    });
  }

  const save = (body, role = 'administrator') => request('PUT', 'config/admin', { role, body: { config: {}, kikoetaWriteback: body } });

  it('publishes only read-only policy anonymously and keeps uploads protected', async function () {
    await start();
    const policy = await request('GET', `${route}/capabilities`);
    assert.strictEqual(policy.status, 200);
    assert.deepStrictEqual(JSON.parse(policy.data), { version: 3, enabled: false, authentication: 'account' });
    assert.strictEqual(policy.headers['cache-control'], 'no-store');
    for (const [method, endpoint] of [['HEAD', route], ['PUT', `${route}/123456?trackPath=01.mp3`], ['POST', `${route}/capabilities`], ['GET', 'config/admin']]) {
      assert.strictEqual((await request(method, endpoint)).status, 401);
    }
  });

  it('uses the account by default and enforces user/admin roles and JWT expiry', async function () {
    await start();
    assert.strictEqual((await save({ enabled: true, authMode: 'account' })).status, 200);
    for (const role of ['user', 'administrator']) {
      const response = await request('HEAD', route, { role });
      assert.strictEqual(response.status, 204);
      assert.strictEqual(response.headers['x-kikoeru-lyrics-writeback'], '2');
    }
    assert.strictEqual((await request('HEAD', route, { role: 'guest' })).headers['x-kikoeru-writeback-error'], 'role_forbidden');
    assert.strictEqual((await request('HEAD', route, { role: 'user', expired: true })).status, 401);
    assert.strictEqual((await request('PUT', `${route}/123456?trackPath=01.mp3`, { role: 'user', body: lyric })).status, 204);
    assert.strictEqual(await fs.promises.readFile(path.join(root, 'RJ123456', '01.mp3.kikoeta.lrc'), 'utf8'), lyric);
    assert.strictEqual((await database('t_work').first()).lyric_status, 'ai');
    assert.strictEqual((await request('PUT', `${route}/123456?trackPath=01.mp3`, { role: 'user', body: lyric })).status, 204);
    assert.strictEqual((await request('PUT', `${route}/123456?trackPath=01.mp3`, { role: 'user', body: 'different' })).status, 409);
  });

  it('requires the additional key only for the enhanced policy', async function () {
    await start();
    assert.strictEqual((await save({ enabled: true, authMode: 'account_and_key' })).status, 400);
    assert.strictEqual((await save({ enabled: true, authMode: 'account_and_key', key })).status, 200);
    for (const suppliedKey of [undefined, 'wrong', key.toLowerCase()]) {
      const response = await request('HEAD', route, { role: 'user', suppliedKey });
      assert.strictEqual(response.status, 403);
      assert.strictEqual(response.headers['x-kikoeru-writeback-error'], 'key_invalid');
    }
    assert.strictEqual((await request('HEAD', route, { role: 'user', suppliedKey: key })).status, 204);
    assert.strictEqual((await save({ enabled: true, authMode: 'account' })).status, 200);
    assert.strictEqual((await request('HEAD', route, { role: 'user' })).status, 204);
    assert.strictEqual(config.kikoetaWritebackKeyHash, hashWritebackKey(key));
    assert.strictEqual((await save({ enabled: true, authMode: 'account_and_key' })).status, 200);
    assert.strictEqual((await request('HEAD', route, { role: 'user' })).status, 403);
  });

  it('keeps legacy keys enforced, including writes from the old admin page', async function () {
    config.kikoetaWritebackEnabled = true;
    config.kikoetaWritebackKeyHash = hashWritebackKey(key);
    await start();
    assert.strictEqual(JSON.parse((await request('GET', `${route}/capabilities`)).data).authentication, 'account_and_key');
    assert.strictEqual((await request('HEAD', route, { role: 'user' })).status, 403);
    assert.strictEqual((await save({ enabled: true })).status, 200);
    assert.strictEqual(config.kikoetaWritebackAuth, 'account_and_key');
    config.kikoetaWritebackAuth = null;
    config.kikoetaWritebackKeyHash = '';
    assert.strictEqual((await save({ enabled: true, key })).status, 200);
    assert.strictEqual(config.kikoetaWritebackAuth, 'account_and_key');
    const output = await request('GET', 'config/admin', { role: 'administrator' });
    assert.ok(!output.data.includes(key));
    assert.ok(!output.data.includes(config.kikoetaWritebackKeyHash));
  });

  it('allows open writeback while preserving the saved enhanced policy', async function () {
    config.auth = false;
    await start();
    assert.strictEqual((await save({ enabled: true, authMode: 'account_and_key' }, null)).status, 200);
    assert.strictEqual((await request('HEAD', route)).status, 204);
    assert.strictEqual((await request('PUT', `${route}/123456?trackPath=01.mp3`, { body: lyric })).status, 204);
    assert.strictEqual(JSON.parse((await request('GET', `${route}/capabilities`)).data).authentication, 'none');
    assert.strictEqual((await request('PUT', 'config/admin', { body: { config: { auth: true } } })).status, 400);
    await save({ enabled: true, authMode: 'account' }, null);
    assert.strictEqual((await request('PUT', 'config/admin', { body: { config: { auth: true } } })).status, 200);
    await start();
    assert.strictEqual((await request('HEAD', route)).status, 401);
    assert.strictEqual((await request('HEAD', route, { role: 'user' })).status, 204);
    await save({ enabled: false, authMode: 'account' });
    assert.strictEqual((await request('HEAD', route, { role: 'user' })).status, 404);
  });

  it('rejects policy injection, invalid modes and invalid legacy hashes', async function () {
    config.kikoetaWritebackEnabled = true;
    config.kikoetaWritebackKeyHash = 'invalid';
    await start();
    assert.strictEqual((await request('HEAD', route, { role: 'user' })).status, 503);
    assert.strictEqual((await save({ enabled: true, authMode: 'none' })).status, 400);
    assert.strictEqual((await save({ enabled: false, authMode: 'account' }, 'user')).status, 403);
    assert.strictEqual((await request('PUT', 'config/admin', { role: 'administrator', body: { config: { kikoetaWritebackAuth: 'account' } } })).status, 400);
  });

  it('migrates legacy environment keys without dropping the extra check', function () {
    const originalFlag = process.env.KIKOERU_KIKOETA_WRITEBACK;
    const originalKey = process.env.KIKOERU_KIKOETA_WRITEBACK_KEY;
    try {
      process.env.KIKOERU_KIKOETA_WRITEBACK = '1';
      process.env.KIKOERU_KIKOETA_WRITEBACK_KEY = key;
      const migrated = getWritebackConfig({ kikoetaWritebackEnabled: null });
      assert.strictEqual(migrated.enabled, true);
      assert.strictEqual(migrated.authMode, 'account_and_key');
      assert.strictEqual(migrated.keyHash, hashWritebackKey(key));
    } finally {
      if (originalFlag === undefined) delete process.env.KIKOERU_KIKOETA_WRITEBACK;
      else process.env.KIKOERU_KIKOETA_WRITEBACK = originalFlag;
      if (originalKey === undefined) delete process.env.KIKOERU_KIKOETA_WRITEBACK_KEY;
      else process.env.KIKOERU_KIKOETA_WRITEBACK_KEY = originalKey;
    }
  });

  it('retains source path checks and reports missing or unwritable tracks', async function () {
    config.kikoetaWritebackEnabled = true;
    await start();
    assert.strictEqual((await request('PUT', `${route}/123456?trackPath=../01.mp3`, { role: 'user', body: lyric })).status, 400);
    const missing = await request('PUT', `${route}/123456?trackPath=missing.mp3`, { role: 'user', body: lyric });
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(JSON.parse(missing.data).code, 'source_unavailable');
    const link = fs.promises.link;
    fs.promises.link = async () => { throw Object.assign(new Error('read-only fixture'), { code: 'EACCES' }); };
    try {
      const denied = await request('PUT', `${route}/123456?trackPath=01.mp3`, { role: 'user', body: lyric });
      assert.strictEqual(denied.status, 503);
      assert.strictEqual(JSON.parse(denied.data).code, 'directory_unwritable');
      assert.deepStrictEqual(await fs.promises.readdir(path.join(root, 'RJ123456')), ['01.mp3']);
      assert.strictEqual((await database('t_work').first()).lyric_status, '');
    } finally { fs.promises.link = link; }
  });
});
