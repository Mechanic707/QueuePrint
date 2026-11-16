const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PUBLISH_DIR = path.resolve(__dirname, '../native/publish');
const HOST_NAME = 'QueuePrint.Host';
const DEPS_NAME = `${HOST_NAME}.deps.json`;
const CONFIG_NAME = `${HOST_NAME}.runtimeconfig.json`;

// These remain mandatory even if a damaged deps manifest omits its assets.
const REQUIRED_NATIVE_FILES = Object.freeze([
  `${HOST_NAME}.exe`,
  `${HOST_NAME}.dll`,
  DEPS_NAME,
  CONFIG_NAME,
  'pdfium.dll',
  'hostfxr.dll',
  'hostpolicy.dll',
  'coreclr.dll',
  'clrjit.dll',
  'System.Private.CoreLib.dll',
  'System.Runtime.dll',
  'System.Runtime.InteropServices.dll',
  'System.Console.dll',
  'System.Text.Json.dll',
  'System.Drawing.Common.dll',
  'System.Drawing.Primitives.dll',
  'System.ComponentModel.Primitives.dll',
  'System.Windows.Forms.dll',
  'System.Windows.Forms.Primitives.dll',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read-only publish-directory validation. Never executes the host, invokes
 * dotnet, downloads files, modifies a printer, or attempts to repair a bundle.
 */
function checkNativePublish(publishDir = DEFAULT_PUBLISH_DIR) {
  const directory = path.resolve(publishDir);
  const required = new Map(REQUIRED_NATIVE_FILES.map(name => [name.toLowerCase(), name]));
  const missing = [];
  const invalid = [];
  const checked = new Set();
  const unavailable = new Set();

  function inspectFile(name) {
    const key = name.toLowerCase();
    if (checked.has(key)) return;
    checked.add(key);
    try {
      const stat = fs.statSync(path.join(directory, name));
      if (!stat.isFile()) {
        invalid.push({ file: name, reason: '应为普通文件，不能是目录' });
        unavailable.add(key);
      } else if (stat.size === 0) {
        invalid.push({ file: name, reason: '文件为空，可能未完成发布或复制' });
        unavailable.add(key);
      }
    } catch (error) {
      unavailable.add(key);
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') missing.push(name);
      else invalid.push({ file: name, reason: `无法读取：${error.message}` });
    }
  }

  function readJson(name) {
    if (unavailable.has(name.toLowerCase())) return null;
    try {
      const value = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8').replace(/^\uFEFF/, ''));
      if (!isObject(value)) throw new Error('顶层必须是 JSON 对象');
      return value;
    } catch (error) {
      invalid.push({ file: name, reason: `JSON 无效：${error.message}` });
      return null;
    }
  }

  REQUIRED_NATIVE_FILES.forEach(inspectFile);
  const config = readJson(CONFIG_NAME);
  if (config) {
    const options = config.runtimeOptions;
    const included = Array.isArray(options?.includedFrameworks) ? options.includedFrameworks : [];
    const names = new Set(included.map(item => item?.name));
    if (!isObject(options) || options.framework || options.frameworks
      || !names.has('Microsoft.NETCore.App') || !names.has('Microsoft.WindowsDesktop.App')) {
      invalid.push({ file: CONFIG_NAME, reason: '必须是同时包含 .NET 和 Windows Desktop 运行时的 self-contained 发布，不能依赖用户预装 .NET' });
    }
  }

  const deps = readJson(DEPS_NAME);
  if (deps) {
    const targetName = deps.runtimeTarget?.name;
    const target = typeof targetName === 'string' ? deps.targets?.[targetName] : null;
    if (typeof targetName !== 'string' || !targetName.endsWith('/win-x64') || !isObject(target)) {
      invalid.push({ file: DEPS_NAME, reason: '缺少有效的 win-x64 运行时依赖清单' });
    } else {
      const libraries = Object.keys(target);
      for (const pack of ['Microsoft.NETCore.App', 'Microsoft.WindowsDesktop.App']) {
        if (!libraries.some(name => name.startsWith(`runtimepack.${pack}.Runtime.win-x64/`))) {
          invalid.push({ file: DEPS_NAME, reason: `缺少 self-contained 运行时依赖：${pack}` });
        }
      }
      const manifestFiles = new Set();
      for (const [libraryName, library] of Object.entries(target)) {
        if (!isObject(library)) {
          invalid.push({ file: DEPS_NAME, reason: `依赖项格式无效：${libraryName}` });
          continue;
        }
        for (const sectionName of ['runtime', 'native']) {
          const assets = library[sectionName];
          if (assets === undefined) continue;
          if (!isObject(assets)) {
            invalid.push({ file: DEPS_NAME, reason: `依赖资源格式无效：${libraryName}/${sectionName}` });
            continue;
          }
          for (const asset of Object.keys(assets)) {
            const normalized = asset.replaceAll('\\', '/');
            const parts = normalized.split('/');
            if (!asset || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)
              || parts.includes('..') || asset.includes('\0')) {
              invalid.push({ file: DEPS_NAME, reason: `依赖资源路径无效：${asset}` });
              continue;
            }
            const name = parts.at(-1);
            // NuGet's _._ marks an intentionally empty asset group. Publish
            // flattens runtime/native assets (including runtimes/.../pdfium.dll).
            if (!name || name === '_._') continue;
            manifestFiles.add(name.toLowerCase());
            if (!required.has(name.toLowerCase())) required.set(name.toLowerCase(), name);
          }
        }
      }
      if (!manifestFiles.has(`${HOST_NAME}.dll`.toLowerCase())) {
        invalid.push({ file: DEPS_NAME, reason: '依赖清单未包含 QueuePrint.Host.dll' });
      }
    }
  }
  for (const name of required.values()) inspectFile(name);

  return {
    ok: missing.length === 0 && invalid.length === 0,
    directory,
    missing,
    invalid,
    requiredFiles: [...required.values()],
    checkedFiles: checked.size,
  };
}

function assertNativePublish(publishDir = DEFAULT_PUBLISH_DIR) {
  const result = checkNativePublish(publishDir);
  if (!result.ok) {
    const details = [
      `本地打印组件不完整，已停止打包。目录：${result.directory}`,
      ...(result.missing.length ? [`缺少文件：${result.missing.join('、')}`] : []),
      ...result.invalid.map(item => `${item.file}：${item.reason}`),
      '请先运行 npm run native:build，再重新打包。请保留整个 native/publish 目录，不能只复制 QueuePrint.Host.exe。',
    ];
    const error = new Error(details.join('\n'));
    error.code = 'NATIVE_PUBLISH_INCOMPLETE';
    error.details = result;
    throw error;
  }
  return result;
}

module.exports = { REQUIRED_NATIVE_FILES, checkNativePublish, assertNativePublish };

if (require.main === module) {
  try {
    const result = assertNativePublish(process.argv[2] || DEFAULT_PUBLISH_DIR);
    console.log(`Native component ready: ${result.checkedFiles} runtime files checked (win-x64, self-contained).`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
