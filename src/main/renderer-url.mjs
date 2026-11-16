import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Chromium normalizes a Windows drive letter to uppercase, while Node's file
// URL can retain the spelling of TEMP. Compare the decoded local file path;
// the caller must still validate the sender and the main frame separately.
export function isSameRendererUrl(actualUrl, expectedUrl, platform = process.platform) {
  try {
    const actual = new URL(actualUrl), expected = new URL(expectedUrl);
    if ([actual, expected].some((url) => url.protocol !== 'file:' || url.hostname
      || url.href.includes('?') || url.href.includes('#'))) return false;
    const windows = platform === 'win32';
    const pathApi = windows ? path.win32 : path.posix;
    const normalize = (url) => {
      const file = pathApi.resolve(fileURLToPath(url, { windows }));
      return windows ? file.toLowerCase() : file;
    };
    return normalize(actual) === normalize(expected);
  } catch {
    return false;
  }
}
