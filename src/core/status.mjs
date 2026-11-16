import { QueuePrintError } from './tree.mjs';

export const JOB_STATUSES = Object.freeze([
  'pending', 'preparing', 'submitting', 'submitted', 'printing',
  'completed', 'failed', 'unknown', 'cancelled',
]);

/** A failed task is safe to auto-retry only with explicit proof it was not sent. */
export function canAutoRetry(job) {
  if (!job || typeof job !== 'object' || job.status !== 'failed') return false;
  return job.submitted === false
    && !job.jobId && !job.submittedAt
    && (job.submissionState === undefined || job.submissionState === 'not-submitted');
}

/**
 * Pure state update. Submission uncertainty is sticky until a person confirms a
 * new attempt. Neither a timeout nor a spooler failure can make reprinting safe.
 */
export function transitionJob(record, nextStatus, details = {}) {
  if (!JOB_STATUSES.includes(nextStatus)) throw new QueuePrintError('INVALID_JOB_STATUS', '未知打印任务状态');
  const current = record || { status: 'pending', submitted: false, submissionState: 'not-submitted', attempt: 1 };
  const isNewAttempt = ['pending', 'preparing', 'submitting'].includes(nextStatus)
    && ['failed', 'unknown', 'cancelled', 'completed'].includes(current.status);
  if (isNewAttempt && !canAutoRetry(current) && details.userConfirmed !== true) {
    throw new QueuePrintError('RETRY_REQUIRES_CONFIRMATION', '该任务可能已经提交，请确认实际出纸情况后重打');
  }
  const { userConfirmed, ...patch } = details;
  const next = { ...current, ...patch, status: nextStatus };
  if (isNewAttempt) {
    next.attempt = (current.attempt || 1) + 1;
    next.submitted = false;
    next.submissionState = 'not-submitted';
    next.jobId = null;
    next.submittedAt = null;
  } else if (current.submitted || current.submissionState === 'submitted') {
    next.submitted = true;
    next.submissionState = current.submissionState;
    next.submittedAt = current.submittedAt || next.submittedAt;
    next.jobId = current.jobId || next.jobId;
  }
  if (['submitted', 'printing', 'completed'].includes(nextStatus)) {
    next.submitted = true;
    next.submissionState = 'submitted';
  } else if (nextStatus === 'unknown' || (!isNewAttempt && current.submissionState === 'unknown')) {
    next.submissionState = 'unknown';
  } else if (nextStatus === 'submitting' && !next.submitted) {
    // Crossing into the native call is uncertain until the caller supplies a
    // definite acknowledgement or proves failure occurred before submission.
    next.submissionState = 'submitting';
  } else if (next.submitted === false && !next.submissionState) {
    next.submissionState = 'not-submitted';
  }
  return next;
}
