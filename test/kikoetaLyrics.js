const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { KIKOETA_LYRIC_SUFFIX, trackPathParts, writeTrackLyric } = require('../filesystem/kikoetaLyrics');
const { getTrackList, getLyricFileStatus, scrapeWorkMemo } = require('../filesystem/utils');
const { config } = require('../config');
const { hashWritebackKey } = require('../auth/kikoetaWriteback');

describe('Kikoeta source lyrics', function () {
  const work = 'RJ123456';
  const title = '01 音声.mp3';
  const content = '[00:01.230] 字幕\n';
  let root;
  let album;
  let track;

  beforeEach(async function () {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'kikoeta-lyrics-'));
    album = path.join(root, work, '特典');
    await fs.mkdir(album, { recursive: true });
    track = path.join(album, title);
    await fs.writeFile(track, 'audio');
  });

  afterEach(async function () {
    await fs.rmdir(root, { recursive: true });
  });

  it('writes next to the exact Unicode track without shifting original indices', async function () {
    const directory = path.join(root, work);
    await fs.writeFile(path.join(album, '02 音声.flac'), 'audio');
    const before = await getTrackList(123456, directory, {});
    assert.strictEqual(await writeTrackLyric(root, work, trackPathParts(`特典\\${title}`), content), true);
    const after = await getTrackList(123456, directory, {});
    assert.deepStrictEqual(after.slice(0, before.length), before);
    assert.strictEqual(after[before.length].title, title + KIKOETA_LYRIC_SUFFIX);
    assert.strictEqual(await fs.readFile(track + KIKOETA_LYRIC_SUFFIX, 'utf8'), content);
  });

  it('rejects traversal, absolute paths and alternate streams', function () {
    for (const value of ['../01.mp3', 'a\\..\\01.mp3', 'D:\\01.mp3', '//server/01.mp3', '/01.mp3', '01.mp3:ads']) {
      assert.strictEqual(trackPathParts(value), null);
    }
  });

  it('does not write beside a missing track or outside the work via a linked folder', async function () {
    await assert.rejects(writeTrackLyric(root, work, ['missing.mp3'], content), { code: 'ENOENT' });
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, title), 'audio');
    await fs.symlink(outside, path.join(root, work, 'linked'), 'junction');
    assert.strictEqual(await writeTrackLyric(root, work, ['linked', title], content), false);
    assert.deepStrictEqual(await fs.readdir(outside), [title]);
  });

  it('publishes one complete file for concurrent writers and preserves it on retry', async function () {
    const alternatives = [content, '[00:01.230] 译文\n'];
    const results = await Promise.all(alternatives.map(lyric =>
      writeTrackLyric(root, work, ['特典', title], lyric).catch(error => error.code)));
    assert.deepStrictEqual(results.slice().sort(), ['EEXIST', true]);
    const destination = track + KIKOETA_LYRIC_SUFFIX;
    assert.strictEqual(await fs.readFile(destination, 'utf8'), alternatives[results.indexOf(true)]);
    assert.deepStrictEqual((await fs.readdir(album)).sort(), [title, title + KIKOETA_LYRIC_SUFFIX]);
  });

  it('cleans up temporary output if publication fails', async function () {
    const link = fs.link;
    fs.link = async () => { throw Object.assign(new Error('read-only'), { code: 'EACCES' }); };
    try {
      await assert.rejects(writeTrackLyric(root, work, ['特典', title], content), { code: 'EACCES' });
      assert.deepStrictEqual(await fs.readdir(album), [title]);
    } finally {
      fs.link = link;
    }
  });

  it('retries the same lyric without replacing existing content', async function () {
    const parts = ['特典', title];
    assert.strictEqual(await writeTrackLyric(root, work, parts, content), true);
    assert.strictEqual(await writeTrackLyric(root, work, parts, content), true);
    await assert.rejects(writeTrackLyric(root, work, parts, '[00:02] changed'), { code: 'EEXIST' });
    assert.strictEqual(await fs.readFile(track + KIKOETA_LYRIC_SUFFIX, 'utf8'), content);
  });

  it('classifies Kikoeta sidecars as AI and preserves separate local lyrics', async function () {
    await fs.unlink(track);
    await fs.writeFile(track + KIKOETA_LYRIC_SUFFIX, content);
    assert.deepStrictEqual(await getLyricFileStatus(album), { isContainLyric: false, isContainAILyric: true });
    let memo = await scrapeWorkMemo(123456, album, {});
    assert.strictEqual(memo.isContainLyric, false);
    assert.strictEqual(memo.isContainAILyric, true);
    await fs.writeFile(path.join(album, 'manual.srt'), 'subtitle');
    memo = await scrapeWorkMemo(123456, album, {});
    assert.strictEqual(memo.isContainLyric, true);
    assert.strictEqual(memo.isContainAILyric, true);
  });
});

describe('Kikoeta writeback authorization', function () {
  it('allows user and administrator roles with the key and rejects other roles', function () {
    const router = require('../routes/media');
    const authorize = router.stack.find(layer => layer.route && layer.route.path === '/kikoeta-lyrics').route.stack[0].handle;
    const original = {
      auth: config.auth,
      kikoetaWritebackEnabled: config.kikoetaWritebackEnabled,
      kikoetaWritebackKeyHash: config.kikoetaWritebackKeyHash,
    };
    const key = 'ABcd1234EFgh5678';
    Object.assign(config, { auth: true, kikoetaWritebackEnabled: true, kikoetaWritebackKeyHash: hashWritebackKey(key) });
    function status(user, suppliedKey) {
      let result;
      authorize({ user, get: () => suppliedKey }, { sendStatus: code => { result = code; } }, () => { result = 204; });
      return result;
    }
    try {
      assert.strictEqual(status({ name: 'user1', group: 'user' }, key), 204);
      assert.strictEqual(status({ name: 'admin', group: 'administrator' }, key), 204);
      assert.strictEqual(status({ name: 'guest1', group: 'guest' }, key), 403);
      assert.strictEqual(status({ name: 'admin', group: 'guest' }, key), 403);
      assert.strictEqual(status({ name: 'unknown', group: 'other' }, key), 403);
      assert.strictEqual(status({ name: 'user1' }, key), 403);
      assert.strictEqual(status({ name: 'user1', group: 'user' }, key.toLowerCase()), 403);
      assert.strictEqual(status({ name: 'user1', group: 'user' }), 403);
      assert.strictEqual(status(undefined, key), 403);
    } finally {
      Object.assign(config, original);
    }
  });
});
