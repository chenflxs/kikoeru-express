const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const knex = require('knex');
const { config } = require('../config');

describe('Kikoeta lyric status in SQLite', function () {
  let database;
  let api;

  beforeEach(async function () {
    database = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await database.schema.createTable('t_work', table => {
      table.integer('id').primary();
      table.string('lyric_status');
      table.string('root_folder');
      table.string('dir');
    });
    await database.schema.createTable('t_translate_task', table => {
      table.integer('work_id');
    });
    await database('t_work').insert({ id: 123456, lyric_status: '' });
    const filename = path.join(__dirname, '../database/db.js');
    const requireFromDatabase = name => require(name.startsWith('.') ? path.resolve(path.dirname(filename), name) : name);
    const scope = {
      module: { exports: {} }, console, process,
      require: name => name === 'knex' ? () => database : requireFromDatabase(name),
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), scope, { filename });
    api = scope.module.exports;
  });

  afterEach(async function () {
    await database.destroy();
  });

  async function status() {
    return (await database('t_work').where('id', 123456).first()).lyric_status;
  }

  it('marks a writeback as AI while retaining current local status', async function () {
    await api.updateWorkAILyricStatus(true, '', 123456);
    assert.strictEqual(await status(), 'ai');
    await database('t_work').where('id', 123456).update({ lyric_status: 'local' });
    await api.updateWorkAILyricStatus(true, '', 123456);
    assert.strictEqual(await status(), 'ai_local');
    await api.updateWorkAILyricStatus(false, '', 123456);
    assert.strictEqual(await status(), 'local');
  });

  it('repairs old local tags and maintains both flags across rescans', async function () {
    await database('t_work').where('id', 123456).update({ lyric_status: 'local' });
    await api.updateWorkFileLyricStatus(123456, { isContainLyric: false, isContainAILyric: true });
    assert.strictEqual(await status(), 'ai');
    await api.updateWorkFileLyricStatus(123456, { isContainLyric: true, isContainAILyric: true });
    assert.strictEqual(await status(), 'ai_local');
    await api.updateWorkFileLyricStatus(123456, { isContainLyric: true, isContainAILyric: false });
    assert.strictEqual(await status(), 'local');
    await api.updateWorkFileLyricStatus(123456, { isContainLyric: false, isContainAILyric: false });
    assert.strictEqual(await status(), '');
  });

  it('keeps the native AI-task flag even when there are no sidecars', async function () {
    await database('t_translate_task').insert({ work_id: 123456 });
    await api.updateWorkFileLyricStatus(123456, { isContainLyric: false, isContainAILyric: false });
    assert.strictEqual(await status(), 'ai');
    await api.updateWorkFileLyricStatus(123456, { isContainLyric: true, isContainAILyric: false });
    assert.strictEqual(await status(), 'ai_local');
  });

  it('retains the AI flag after native tasks are removed if a sidecar still exists', async function () {
    await database.schema.createTable('t_review', table => {
      for (const name of ['work_id', 'rating', 'review_text', 'progress', 'updated_at', 'user_name']) table.string(name);
    });
    await database.schema.createTable('t_play_histroy', table => {
      for (const name of ['work_id', 'state', 'updated_at', 'user_name']) table.string(name);
    });
    await database.raw('CREATE VIEW staticMetadata AS SELECT * FROM t_work');
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kikoeta-ai-status-'));
    const lyric = path.join(directory, 'track.mp3.kikoeta.lrc');
    const originalRoots = config.rootFolders;
    try {
      await fs.promises.writeFile(lyric, '[00:01] AI');
      config.rootFolders = [{ name: 'test', path: directory }];
      await database('t_work').where('id', 123456).update({ root_folder: 'test', dir: '', lyric_status: 'ai' });
      await api.markWorkAILyricStatus(123456, 'user1', false);
      assert.strictEqual(await status(), 'ai');
      await fs.promises.unlink(lyric);
      await api.markWorkAILyricStatus(123456, 'user1', false);
      assert.strictEqual(await status(), '');
    } finally {
      config.rootFolders = originalRoots;
      if (fs.existsSync(lyric)) await fs.promises.unlink(lyric);
      await fs.promises.rmdir(directory);
    }
  });
});
