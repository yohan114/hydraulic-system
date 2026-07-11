'use strict';

/**
 * A tiny async mutex.
 *
 * Two overlapping HTTP requests can interleave a "read the last invoice number"
 * and an "insert" and end up with duplicate numbers. Serialising the whole
 * critical section (generate number -> insert header -> insert items -> deduct
 * stock) through this mutex removes that race at the application level.
 *
 * (With the synchronous better-sqlite3 driver each statement now runs
 *  atomically in-process, but the mutex still guards the multi-statement
 *  invoice/stock critical section as a single unit.)
 */
class Mutex {
  constructor() {
    /** @type {Promise<void>} */
    this._tail = Promise.resolve();
  }

  /**
   * Run `fn` with exclusive access. Calls are queued FIFO; a rejection in one
   * holder does not break the chain for the next waiter.
   * @template T
   * @param {() => (T | Promise<T>)} fn
   * @returns {Promise<T>}
   */
  runExclusive(fn) {
    const run = this._tail.then(() => fn());
    // Keep the chain alive regardless of whether fn resolves or rejects.
    this._tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

module.exports = { Mutex };
