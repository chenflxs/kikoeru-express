const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { KIKOETA_LYRIC_SUFFIX, trackPathParts, writeTrackLyric } = require('../filesystem/kikoetaLyrics');
const { getTrackList } = require('../filesystem/utils');

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
});
