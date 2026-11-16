import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const supported = new Set(['.pdf', '.jpg', '.jpeg', '.png']);
const natural = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

export class FileRegistry {
  constructor(inspect) { this.inspect = inspect; this.files = new Map(); this.byPath = new Map(); this.rootLabels = new Map(); }

  labelForRoot(absolute) {
    const key = absolute.toLowerCase();
    if (this.rootLabels.has(key)) return this.rootLabels.get(key);
    const base = path.basename(absolute) || path.parse(absolute).root.replace(/[:\\/]/g, '') || '文件夹';
    const occupied = new Set([...this.rootLabels.values()].map((label) => label.toLowerCase()));
    let label = base, count = 2;
    while (occupied.has(label.toLowerCase())) label = `${base} (${count++})`;
    this.rootLabels.set(key, label); return label;
  }

  async importPaths(paths, { folders = false } = {}) {
    const entries = [], warnings = [];
    let skipped = 0;
    const visit = async (absolute, relative) => {
      let stat;
      try { stat = await fs.lstat(absolute); } catch (error) { warnings.push(`${relative}：${error.message}`); return; }
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) {
        let children;
        try { children = await fs.readdir(absolute, { withFileTypes: true }); }
        catch (error) { warnings.push(`${relative}：${error.message}`); return; }
        children.sort((a, b) => natural.compare(a.name, b.name));
        for (const child of children) await visit(path.join(absolute, child.name), `${relative}/${child.name}`);
      } else if (stat.isFile() && supported.has(path.extname(absolute).toLowerCase())) {
        entries.push({ path: path.resolve(absolute), relativePath: relative.replaceAll('\\', '/'), size: stat.size, modified: stat.mtimeMs });
      } else if (stat.isFile()) skipped++;
    };
    for (const input of paths) {
      const absolute = path.resolve(input);
      await visit(absolute, folders ? this.labelForRoot(absolute) : `添加的文件/${path.basename(absolute)}`);
    }
    const unique = [...new Map(entries.map((entry) => [entry.path.toLowerCase(), entry])).values()];
    const result = [];
    for (let index = 0; index < unique.length; index += 40) {
      const batch = unique.slice(index, index + 40);
      const response = await this.inspect(batch.map((entry) => entry.path));
      const metadata = Array.isArray(response) ? response : response?.files || response?.items || [];
      for (const entry of batch) {
        const info = metadata.find((item) => item.path?.toLowerCase() === entry.path.toLowerCase()) || {};
        const id = this.byPath.get(entry.path.toLowerCase()) || randomUUID();
        const error = info.error ? (typeof info.error === 'string' ? info.error : info.error.message || '无法读取文件')
          : info.canPrint === false ? 'PDF 设置了打印限制，请使用允许打印的版本。' : undefined;
        const previous = this.files.get(id);
        const descriptor = {
          ...entry, id, name: path.basename(entry.path), kind: path.extname(entry.path).toLowerCase() === '.pdf' ? 'pdf' : 'image',
          ...(!folders && previous ? { relativePath: previous.relativePath } : {}),
          pages: Number.isInteger(info.pages) ? info.pages : Number.isInteger(info.pageCount) ? info.pageCount : null,
          width: info.width, height: info.height,
          ...(error ? { error } : {}),
        };
        if (!descriptor.pages && !descriptor.error) descriptor.error = '无法读取页数，文件可能已损坏或需要密码。';
        this.files.set(id, descriptor); this.byPath.set(entry.path.toLowerCase(), id); result.push(descriptor);
      }
    }
    return { files: result, warnings, skipped };
  }

  async importDroppedPaths(paths) {
    const directories = [], looseFiles = [], warnings = [];
    const unique = [...new Map(paths.map((value) => {
      if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('请拖入有效的本地文件夹或文件。');
      const absolute = path.resolve(value);
      return [absolute.toLowerCase(), absolute];
    })).values()];
    for (const absolute of unique) {
      try {
        const stat = await fs.lstat(absolute);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) directories.push(absolute);
        else if (stat.isFile()) looseFiles.push(absolute);
      } catch (error) { warnings.push(`${path.basename(absolute)}：${error.message}`); }
    }
    const isInside = (parent, child) => {
      const relative = path.relative(parent.toLowerCase(), child.toLowerCase());
      return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    };
    const roots = directories.filter((directory) => !directories.some((other) => other !== directory && isInside(other, directory)));
    const leaves = looseFiles.filter((file) => !roots.some((directory) => isInside(directory, file)));
    const folderResult = roots.length ? await this.importPaths(roots, { folders: true }) : { files: [], warnings: [], skipped: 0 };
    const fileResult = leaves.length ? await this.importPaths(leaves) : { files: [], warnings: [], skipped: 0 };
    return {
      files: [...new Map([...folderResult.files, ...fileResult.files].map((file) => [file.id, file])).values()],
      warnings: [...warnings, ...folderResult.warnings, ...fileResult.warnings],
      skipped: folderResult.skipped + fileResult.skipped,
    };
  }

  get(id) {
    const file = this.files.get(String(id));
    if (!file) throw new Error('文件不在当前导入清单内，请重新导入。');
    return file;
  }

  async assertUnchanged(id) {
    const file = this.get(id), stat = await fs.stat(file.path);
    if (stat.size !== file.size || Math.abs(stat.mtimeMs - file.modified) > 1) {
      throw new Error(`文件已发生变化，请重新导入后再打印：${file.name}`);
    }
    return file;
  }

  async bytes(id) {
    const file = await this.assertUnchanged(id);
    const bytes = await fs.readFile(file.path);
    return { bytes: new Uint8Array(bytes), kind: file.kind, name: file.name };
  }
}
