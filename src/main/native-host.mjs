import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

export function findNativeHost(appRoot, resourcesPath, { packaged = false } = {}) {
  const candidates = [
    path.join(resourcesPath, 'native', 'QueuePrint.Host.exe'),
    path.join(appRoot, 'native', 'publish', 'QueuePrint.Host.exe'),
  ];
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) {
    const error = new Error(packaged
      ? '本地打印组件缺失，请关闭所有序印窗口后重新打开程序；若仍失败，请重新下载完整的 Windows 版。'
      : '本地打印组件尚未构建。请先运行 npm run native:build。');
    error.code = 'NATIVE_HOST_MISSING';
    error.submissionStarted = false;
    throw error;
  }
  return executable;
}

export function runNative(executable, request, { timeout = 120_000, onEvent } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], {
      cwd: path.dirname(executable), windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'], shell: false,
      env: { ...process.env, DOTNET_NOLOGO: '1' },
    });
    let final, stderr = '', settled = false, submissionStarted = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(request.command === 'print'
        ? '打印组件响应超时，提交状态不明。请检查 Windows 打印队列，确认后再决定是否重打。'
        : '本地打印组件响应超时，请检查打印机连接。'));
    }, timeout);
    const lines = createInterface({ input: child.stdout });
    function finish(error) {
      if (settled) return;
      settled = true; clearTimeout(timer); lines.close();
      if (error) {
        error.submissionStarted = submissionStarted;
        reject(error);
      } else if (final?.ok) resolve(final.data);
      else {
        const failure = new Error(final?.error?.message || stderr.trim() || '本地打印组件未返回有效结果。');
        failure.code = final?.error?.code;
        failure.submissionStarted = submissionStarted || failure.code === 'SUBMISSION_UNCERTAIN';
        reject(failure);
      }
    }
    lines.on('line', (line) => {
      try {
        const value = JSON.parse(line.replace(/^\uFEFF/, ''));
        if (typeof value.ok === 'boolean') final = value;
        else if (value.event) {
          if (value.event === 'submission-started' || value.event === 'submission-uncertain') submissionStarted = true;
          onEvent?.(value);
        }
      } catch { /* Native diagnostic lines are not protocol replies. */ }
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-8000); });
    child.on('error', finish);
    child.on('close', (code) => finish(final ? undefined : new Error(stderr.trim() || `本地打印组件退出，代码 ${code}。`)));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request) + '\n', 'utf8');
  });
}
