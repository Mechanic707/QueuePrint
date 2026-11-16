import test from 'node:test';
import assert from 'node:assert/strict';
import { isSameRendererUrl } from '../src/main/renderer-url.mjs';

const trusted = 'file:///d:/a/_temp/nsTest.tmp/app/resources/app.asar/src/renderer/index.html';

test('renderer trust accepts Chromium drive normalization and Windows path casing', () => {
  assert.equal(isSameRendererUrl(trusted.replace('d:', 'D:'), trusted, 'win32'), true);
  assert.equal(isSameRendererUrl(trusted.toUpperCase().replace('FILE:', 'file:'), trusted, 'win32'), true);
});

test('renderer trust compares decoded Unicode and space paths', () => {
  const actual = 'file:///D:/%E6%9D%90%E6%96%99%20%E6%B8%85%E5%8D%95/app.asar/index.html';
  const expected = 'file:///d:/材料 清单/app.asar/index.html';
  assert.equal(isSameRendererUrl(actual, expected, 'win32'), true);
  assert.equal(isSameRendererUrl(actual.replaceAll('%E6', '%e6'), expected, 'win32'), true);
});

test('renderer trust rejects other files, remote origins, query strings and fragments', () => {
  for (const actual of [
    trusted.replace('index.html', 'other.html'),
    trusted.replace('/renderer/', '/untrusted/'),
    trusted + '?mode=other', trusted + '#other', trusted + '?', trusted + '#',
    'https://example.com/index.html', 'about:blank',
    'file://server/share/index.html', '', undefined,
  ]) assert.equal(isSameRendererUrl(actual, trusted, 'win32'), false, String(actual));
});

test('renderer trust rejects malformed URLs and encoded path separators', () => {
  for (const actual of ['file:///D:/broken%escape', trusted.replace('/renderer/', '%2Frenderer%2F'), trusted.replace('/renderer/', '%5Crenderer%5C')]) {
    assert.equal(isSameRendererUrl(actual, trusted, 'win32'), false);
  }
});

test('renderer trust preserves case-sensitive paths outside Windows', () => {
  const expected = 'file:///tmp/QueuePrint/index.html';
  assert.equal(isSameRendererUrl(expected, expected, 'linux'), true);
  assert.equal(isSameRendererUrl(expected.toLowerCase(), expected, 'linux'), false);
});
