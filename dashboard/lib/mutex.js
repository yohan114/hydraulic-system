'use strict';

/**
 * A tiny async mutex.
 *
 * node-adodb executes each statement in a short-lived out-of-process worker, so
 * two overlapping HTTP requests can interleave a "read the last invoice number"
 * and an "insert" and end up with duplicate numbers. Serialising the whole
 * critical section (generate number -> insert header -> insert items -> deduct
 * stock) through this mutex removes that race without needing DB-level locking,
 * which Access does not offer through this driver.
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
