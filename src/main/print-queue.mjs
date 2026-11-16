import { randomUUID } from 'node:crypto';
import { FileProgress } from './file-progress.mjs';

const duplexModes = { simplex: 'simplex', long: 'longEdge', short: 'shortEdge', longEdge: 'longEdge', shortEdge: 'shortEdge' };

export function nativeSettings(settings = {}, fallbackDevMode) {
  const duplex = duplexModes[settings.duplex || 'simplex'];
  if (!duplex) throw new Error('不支持的单双面设置。');
  const scale = settings.scale || 'fit';
  if (!['fit', 'actual', 'shrink'].includes(scale)) throw new Error('不支持的缩放设置。');
  const orientation = settings.orientation || 'auto';
  if (!['auto', 'portrait', 'landscape'].includes(orientation)) throw new Error('不支持的页面方向。');
  const devModeBase64 = settings.devModeBase64 || fallbackDevMode;
  if (devModeBase64 && (typeof devModeBase64 !== 'string' || devModeBase64.length > 1_000_000 || !/^[A-Za-z0-9+/=]+$/.test(devModeBase64))) {
    throw new Error('打印机高级属性无效，请重新设置。');
  }
  return {
    duplex, scale, orientation,
    ...(orientation === 'auto' ? {} : { landscape: orientation === 'landscape' }),
    color: settings.color === 'color' || settings.color === true,
    paperSize: String(settings.paper || settings.paperSize || 'A4').slice(0, 60),
    ...(devModeBase64 ? { devModeBase64 } : {}),
  };
}

export class PrintQueue {
  constructor({ registry, runNative, emit, audit = () => {} }) {
    this.registry = registry; this.runNative = runNative; this.emit = emit; this.audit = audit;
    this.batch = null; this.wake = null; this.done = Promise.resolve(); this.submitting = false; this.cancelPreparing = false;
  }
  isBusy() { return this.submitting || (!!this.batch && ['running', 'paused', 'stopping'].includes(this.batch.status)); }

  event(status, message, extra = {}) {
    const b = this.batch;
    if (!b) return;
    if (status) b.status = status;
    const payload = {
      batchId: b.id, status: b.status, taskIndex: b.index, taskCount: b.tasks.length, totalTasks: b.tasks.length,
      ...b.progress.snapshot(), jobs: [...b.jobs], message, ...extra,
    };
    this.emit(payload); if (!extra.transient) this.audit(payload); return payload;
  }

  async submit(plan) {
    if (this.isBusy()) throw new Error('已有批次正在提交，请先完成或停止后续任务。');
    this.submitting = true; this.cancelPreparing = false;
    try { return await this.prepare(plan); }
    finally { this.submitting = false; }
  }

  async prepare(plan) {
    if (!plan?.printerName || typeof plan.printerName !== 'string') throw new Error('请先选择打印机。');
    if (plan.ready === false || plan.errors?.length) throw new Error('打印清单存在错误，请先处理页码或文件问题。');
    if (!Array.isArray(plan.tasks) || !plan.tasks.length) throw new Error('没有可打印的文件。');
    if (plan.tasks.length > 10_000) throw new Error('当前批次过大，请分批打印。');
    const tasks = [];
    let pageCount = 0;
    for (const task of plan.tasks) {
      if (!Array.isArray(task.segments) || !task.segments.length) throw new Error('打印任务为空。');
      const documents = [], details = [];
      for (const segment of task.segments) {
        const file = await this.registry.assertUnchanged(segment.fileId);
        if (file.error || !file.pages) throw new Error(`文件无法打印：${file.name}，${file.error || '无法确定页数'}`);
        const pages = segment.pages;
        if (!Array.isArray(pages) || !pages.length || pages.some((page) => !Number.isInteger(page) || page < 1 || page > file.pages)) {
          throw new Error(`页码范围无效：${file.name}`);
        }
        pageCount += pages.length + Number(!!segment.appendBlank);
        if (pageCount > 100_000) throw new Error('当前批次页数过多，请分批打印。');
        documents.push({ path: file.path, pages: [...pages], appendBlank: !!segment.appendBlank, startOnFront: !!segment.startOnFront, fileId: file.id });
        details.push({ name: file.name, relativePath: file.relativePath || file.name,
          setIndex: Number.isInteger(segment.setIndex) && segment.setIndex > 0 ? segment.setIndex : undefined });
      }
      tasks.push({ documents, details, settings: nativeSettings(task.settings, plan.devModeBase64 || plan.devmode) });
    }
    if (this.cancelPreparing) throw new Error('批次已取消，未提交任何任务。');
    const id = randomUUID();
    this.batch = {
      id, status: 'running', printerName: plan.printerName, jobName: String(plan.jobName || '序印批量打印').slice(0, 100),
      tasks, index: 0, progress: new FileProgress(tasks), jobs: [], jobKeys: new Set(), lastProgressAt: 0,
      pauseRequested: false, stopRequested: false, needsConfirmation: false,
    };
    this.event('running', '开始按清单顺序提交打印任务。');
    this.done = this.process().catch((error) => {
      const pending = this.batch.progress.unconfirmed(this.batch.index);
      const uncertain = pending.length > 0 && error.submissionStarted !== false;
      this.batch.needsConfirmation = uncertain;
      if (uncertain) this.batch.progress.markUncertain(this.batch.index);
      this.event('failed', uncertain
        ? `该任务提交状态不明，请检查 Windows 打印队列后决定是否重打。${error.message}`
        : pending.length ? `当前任务未提交，已停止后续提交。${error.message}`
          : `当前任务已确认提交，但组件返回中断，已停止后续提交。${error.message}`, { needsConfirmation: uncertain, error: error.message });
    });
    return { batchId: id };
  }

  async process() {
    const b = this.batch;
    while (b.index < b.tasks.length) {
      if (b.stopRequested) break;
      if (b.pauseRequested) {
        this.event('paused', '已暂停后续任务。已提交的任务可能继续出纸。');
        await new Promise((resolve) => { this.wake = resolve; });
        this.wake = null;
        if (b.stopRequested) break;
      }
      const task = b.tasks[b.index];
      try { for (const document of task.documents) await this.registry.assertUnchanged(document.fileId); }
      catch (error) { error.submissionStarted = false; throw error; }
      b.progress.startTask(b.index);
      this.event('running', '正在按清单顺序处理文件，等待 Windows 确认提交。');
      const response = await this.runNative({
        command: 'print', printerName: b.printerName, jobName: `${b.jobName} ${b.index + 1}/${b.tasks.length}`,
        settings: task.settings, documents: task.documents, copies: 1,
        startEachDocumentOnFront: false, startEachSetOnFront: false,
      }, {
        timeout: 30 * 60_000,
        onEvent: (event) => this.nativeProgress(b, task, event),
      });
      for (const job of Array.isArray(response?.jobs) ? response.jobs : []) this.addJob(b, job);
      // A normal final response also covers older helpers without granular events.
      b.progress.confirm(b.index, task.documents.map((_, index) => index));
      b.index++;
      this.event(b.stopRequested ? 'stopping' : 'running', `已确认提交 ${b.progress.submittedFiles} / ${b.progress.files.size} 个文件。`);
    }
    if (b.stopRequested) this.event('stopped', '已停止后续任务。已提交的任务仍可能继续出纸，请在 Windows 打印队列查看。');
    else this.event('submitted', '本批次已交给 Windows 打印队列。实际出纸状态请查看打印机。');
  }

  addJob(batch, job) {
    if (!job || typeof job !== 'object') return;
    const key = `${batch.index}:${job.groupIndex ?? 0}:${job.documentName || job.jobId || ''}`;
    if (!batch.jobKeys.has(key)) { batch.jobKeys.add(key); batch.jobs.push({ ...job }); }
  }

  nativeProgress(batch, task, event) {
    if (this.batch !== batch || batch.tasks[batch.index] !== task) return;
    if (['document-processing', 'document-progress'].includes(event.event)) {
      const previousFile = batch.progress.current;
      if (!batch.progress.updateDocument(batch.index, event)) return;
      const now = Date.now();
      if (event.documentComplete || previousFile !== batch.progress.current || now - batch.lastProgressAt >= 100) {
        batch.lastProgressAt = now;
        this.event(null, '文件正在处理；已处理完成的文件需等待所属任务提交确认。', { nativeEvent: event.event, transient: true });
      }
    } else if (event.event === 'job-submitted' && event.job?.status === 'submitted') {
      if (batch.progress.confirm(batch.index, event.job.documentIndices)) {
        this.addJob(batch, event.job);
        this.event(null, `已确认提交 ${batch.progress.submittedFiles} / ${batch.progress.files.size} 个文件。`, { nativeEvent: event.event });
      }
    } else if (event.message) this.event(null, event.message, { nativeEvent: event.event });
  }

  pause() {
    if (this.submitting) return { status: 'preparing' };
    if (!this.isBusy()) return { status: this.batch?.status || 'idle' };
    this.batch.pauseRequested = true;
    return this.event(null, '已请求暂停，当前任务结束后停止提交后续任务。');
  }
  resume() {
    if (this.submitting) return { status: 'preparing' };
    if (!this.isBusy()) return { status: this.batch?.status || 'idle' };
    this.batch.pauseRequested = false; this.wake?.();
    return this.event('running', '继续提交后续任务。');
  }
  stop() {
    if (this.submitting) { this.cancelPreparing = true; return { status: 'stopping' }; }
    if (!this.isBusy()) return { status: this.batch?.status || 'idle' };
    this.batch.stopRequested = true; this.batch.pauseRequested = false; this.wake?.();
    return this.event('stopping', '正在停止后续任务，当前已提交任务可能继续出纸。');
  }
}
