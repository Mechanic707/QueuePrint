const FILE_LIST_LIMIT = 100;

/** Tracks each occurrence separately; rendering a file is not a spool receipt. */
export class FileProgress {
  constructor(tasks) {
    this.files = new Map();
    this.current = null;
    this.processedPages = 0;
    this.processedUnits = 0;
    this.submittedUnits = 0;
    this.processedFiles = 0;
    this.submittedFiles = 0;
    this.totalPages = 0;
    this.totalUnits = 0;
    this.completedFileIds = new Set();
    this.currentIndices = tasks.map(() => -1);
    this.tasks = tasks.map((task) => task.documents.map((document, index) => {
      const details = task.details[index];
      let file = this.files.get(document.fileId);
      if (!file) {
        file = { fileId: document.fileId, name: details.name, relativePath: details.relativePath,
          totalUnits: 0, processedUnits: 0, submittedUnits: 0, uncertainUnits: 0 };
        this.files.set(document.fileId, file);
      }
      file.totalUnits++;
      this.totalUnits++;
      this.totalPages += document.pages.length;
      return { file, copyIndex: file.totalUnits, contentPages: document.pages.length,
        appendBlank: document.appendBlank, setIndex: details.setIndex,
        processedPages: 0, complete: false, committed: false, uncertain: false, blank: false };
    }));
  }

  startTask(index) {
    this.current = this.tasks[index]?.[0] || null;
    this.currentIndices[index] = 0;
  }

  updateDocument(taskIndex, event) {
    const units = this.tasks[taskIndex];
    if (!units || !Number.isInteger(event.documentIndex) || event.documentIndex < 0) return false;
    const unit = units[event.documentIndex];
    if (!unit || unit.committed || event.fileId !== unit.file.fileId
      || event.contentPages !== unit.contentPages || !Number.isInteger(event.processedPages)
      || event.processedPages < unit.processedPages || event.processedPages > unit.contentPages
      || event.processedPages < 0 || (event.blank && (!unit.appendBlank || event.processedPages !== unit.contentPages))) return false;
    const completed = event.event === 'document-progress' && event.documentComplete === true
      && event.processedPages === unit.contentPages && (!unit.appendBlank || event.blank === true);
    const changed = this.markProcessed(unit, event.processedPages, completed);
    // Late or duplicate events can fill missing progress, but cannot move the
    // current-file indicator backwards after the native stream advanced.
    if (event.documentIndex >= this.currentIndices[taskIndex]) {
      this.currentIndices[taskIndex] = event.documentIndex;
      this.current = unit.complete ? null : unit;
      unit.blank = !!event.blank;
    }
    return changed || event.event === 'document-processing';
  }

  markProcessed(unit, pages, complete) {
    let changed = false;
    if (pages > unit.processedPages) {
      this.processedPages += pages - unit.processedPages;
      unit.processedPages = pages;
      changed = true;
    }
    if (complete && !unit.complete) {
      unit.complete = true;
      this.processedUnits++;
      unit.file.processedUnits++;
      if (unit.file.processedUnits === unit.file.totalUnits) this.processedFiles++;
      changed = true;
    }
    return changed;
  }

  confirm(taskIndex, indices) {
    const units = this.tasks[taskIndex];
    if (!units || !Array.isArray(indices) || !indices.length
      || indices.some((index) => !Number.isInteger(index) || index < 0 || index >= units.length)) return false;
    let changed = false;
    for (const index of new Set(indices)) {
      const unit = units[index];
      if (unit.committed) continue;
      this.markProcessed(unit, unit.contentPages, true);
      unit.committed = true;
      this.submittedUnits++;
      unit.file.submittedUnits++;
      if (unit.uncertain) { unit.uncertain = false; unit.file.uncertainUnits--; }
      if (unit.file.submittedUnits === unit.file.totalUnits) {
        this.submittedFiles++;
        this.completedFileIds.add(unit.file.fileId);
      }
      if (this.current === unit) this.current = null;
      changed = true;
    }
    return changed;
  }

  unconfirmed(taskIndex) { return (this.tasks[taskIndex] || []).filter((unit) => !unit.committed); }

  markUncertain(taskIndex) {
    for (const unit of this.unconfirmed(taskIndex)) {
      if (!unit.uncertain) { unit.uncertain = true; unit.file.uncertainUnits++; }
    }
  }

  snapshot() {
    const fileProgress = [];
    for (const file of this.files.values()) {
      if (fileProgress.length === FILE_LIST_LIMIT) break;
      fileProgress.push({ ...file });
    }
    const current = this.current;
    return {
      processedFiles: this.processedFiles, submittedFiles: this.submittedFiles, totalFiles: this.files.size,
      processedUnits: this.processedUnits, submittedUnits: this.submittedUnits, totalUnits: this.totalUnits,
      processedPages: this.processedPages, totalPages: this.totalPages,
      fileIds: [...this.completedFileIds], fileProgress, fileProgressLimit: FILE_LIST_LIMIT,
      currentFile: current ? { fileId: current.file.fileId, name: current.file.name, relativePath: current.file.relativePath,
        copyIndex: current.copyIndex, totalUnits: current.file.totalUnits, processedPages: current.processedPages,
        contentPages: current.contentPages, blank: current.blank, setIndex: current.setIndex } : null,
    };
  }
}
