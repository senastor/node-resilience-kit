'use strict';

class MinHeap {
  constructor() { this._data = []; }

  push(item) {
    this._data.push(item);
    this._siftUp(this._data.length - 1);
  }

  pop() {
    if (this._data.length === 0) return undefined;
    const top = this._data[0];
    const last = this._data.pop();
    if (this._data.length > 0) {
      this._data[0] = last;
      this._siftDown(0);
    }
    return top;
  }

  peek() { return this._data[0]; }
  get size() { return this._data.length; }

  clear() { this._data.length = 0; }

  // Max-heap: higher priority bubbles to top
  _cmp(i, j) { return this._data[i].priority > this._data[j].priority; }

  _siftUp(i) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this._cmp(i, p)) {
        [this._data[i], this._data[p]] = [this._data[p], this._data[i]];
        i = p;
      } else break;
    }
  }

  _siftDown(i) {
    const n = this._data.length;
    while (true) {
      let smallest = i;
      const l = 2 * i + 1, r = 2 * i + 2;
      if (l < n && this._cmp(l, smallest)) smallest = l;
      if (r < n && this._cmp(r, smallest)) smallest = r;
      if (smallest !== i) {
        [this._data[i], this._data[smallest]] = [this._data[smallest], this._data[i]];
        i = smallest;
      } else break;
    }
  }
}

class TaskQueue {
  constructor(concurrency = 1, opts = {}) {
    this._concurrency = concurrency;
    this._running = 0;
    this._paused = false;
    this._queue = new MinHeap();
    this._onDrain = opts.onDrain || null;
    this._onFailed = opts.onFailed || null;
  }

  enqueue(fn, opts = {}) {
    const priority = opts.priority ?? 0;
    const retries = opts.retries ?? 0;

    return new Promise((resolve, reject) => {
      this._queue.push({
        fn,
        priority,
        retries,
        maxRetries: retries,
        resolve,
        reject,
      });
      this._next();
    });
  }

  _next() {
    while (this._running < this._concurrency && this._queue.size > 0 && !this._paused) {
      const task = this._queue.pop();
      this._running++;
      this._run(task);
    }
  }

  async _run(task) {
    try {
      const result = await task.fn();
      task.resolve(result);
    } catch (err) {
      if (task.retries > 0) {
        task.retries--;
        this._queue.push(task);
        this._running--;
        this._next();
        return;
      }
      if (this._onFailed) {
        this._onFailed(task, err, task.retries);
      }
      task.reject(err);
    }
    this._running--;
    this._next();
    this._checkDrain();
  }

  _checkDrain() {
    if (this._running === 0 && this._queue.size === 0 && this._onDrain) {
      this._onDrain();
    }
  }

  pause() { this._paused = true; }

  resume() {
    this._paused = false;
    this._next();
  }

  clear() {
    while (this._queue.size > 0) {
      const task = this._queue.pop();
      task.reject(new Error('Queue cleared'));
    }
  }

  get size() { return this._queue.size; }
  get pending() { return this._running; }
  get isPaused() { return this._paused; }
}

module.exports = { TaskQueue };
