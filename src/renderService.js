/**
 * Promise wrapper around the rendering worker.
 *
 * Only the newest request matters. Panning the map or nudging a slider while a
 * dense algorithm is still running would otherwise queue work that is already
 * stale, so a new request supersedes the one in flight and the old promise settles
 * as cancelled rather than being left hanging.
 */

let worker = null;
let nextId = 1;
const pending = new Map();

function ensureWorker() {
  if (worker) return worker;

  worker = new Worker(new URL('./worker/render.worker.js', import.meta.url), {
    type: 'module',
  });

  worker.onmessage = (event) => {
    const { id, type, result, message, fraction } = event.data;
    const job = pending.get(id);
    if (!job) return;

    if (type === 'progress') {
      if (job.onProgress) job.onProgress({ message, fraction });
      return;
    }

    pending.delete(id);
    if (type === 'done') job.resolve(result);
    else job.reject(new Error(message));
  };

  worker.onerror = (event) => {
    for (const [id, job] of pending) {
      pending.delete(id);
      job.reject(new Error(event.message || 'Rendering worker failed'));
    }
  };

  return worker;
}

/** Abandon anything still in flight. */
export function cancelPending(reason = 'Superseded by a newer render') {
  for (const [id, job] of pending) {
    pending.delete(id);
    job.reject(Object.assign(new Error(reason), { cancelled: true }));
  }
}

/**
 * @param {object} request - see the worker for the accepted shape
 * @param {Function} [onProgress]
 * @returns {Promise<object>}
 */
export function requestRender(request, onProgress) {
  cancelPending();

  const id = nextId++;
  const promise = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
  });

  ensureWorker().postMessage({ id, request });
  return promise;
}

/** Was this rejection just an older render being replaced? */
export function isCancellation(error) {
  return !!(error && error.cancelled);
}
