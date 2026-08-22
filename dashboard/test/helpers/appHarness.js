'use strict';

/**
 * Integration-test harness.
 *
 * Boots the REAL app — every router, the auth gate, the role guard, the posting
 * rules — against a throwaway SQLite file, on an ephemeral port. Nothing here
 * touches the shop's live database.
 *
 * The unit tests in this folder cover the pure engines (money, billing, pricing,
 * finance). This covers the wiring those engines sit inside, which is where the
 * ERP work will spend most of its risk.
 *
 * Usage:
 *
 *   const { startTestApp } = require('./helpers/appHarness');
 *   const app = await startTestApp();
 *   try {
 *     const res = await app.get('/api/inventory');
 *     assert.equal(res.status, 200);
 *   } finally {
 *     await app.close();
 *   }
 *
 * IMPORTANT: db.js resolves its path once, at require time, from HYDRAULIC_DB.
 * The harness therefore sets that variable BEFORE requiring the app, and each
 * test FILE gets its own database. `node --test` runs files in separate
 * processes, so that isolation holds.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

/**
 * @param {object} [opts]
 * @param {boolean} [opts.auth=false] leave the login gate on (default: off, so
 *   tests can hit endpoints directly without a token)
 * @param {boolean} [opts.migrate=true] run baseline + migrations on the temp DB
 * @returns {Promise<{baseUrl:string, db:object, dbFile:string, request:Function,
 *   get:Function, post:Function, put:Function, del:Function, close:Function}>}
 */
async function startTestApp(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydraulic-test-'));
  const dbFile = path.join(dir, 'test.db');

  // Must be set before db.js is required — see the note above.
  process.env.HYDRAULIC_DB = dbFile;
  process.env.BILLING_AUTH = opts.auth ? 'on' : 'off';
  process.env.BILLING_SECRET = process.env.BILLING_SECRET || crypto.randomBytes(16).toString('hex');

  const connection = require('../../db');
  if (opts.migrate !== false) {
    const { migrateToLatest } = require('../../migrate');
    // No safety copy for a throwaway file, and no console noise.
    await migrateToLatest(connection, { backup: false, log: () => {} });
  }

  const { app } = require('../../server');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  let token = null;

  async function request(method, url, body, headers = {}) {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    if (token) init.headers.Authorization = `Bearer ${token}`;
    const res = await fetch(baseUrl + url, init);
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    return { status: res.status, ok: res.ok, headers: res.headers, body: json, text };
  }

  return {
    baseUrl,
    dbFile,
    db: connection,
    request,
    get: (u, h) => request('GET', u, undefined, h),
    post: (u, b, h) => request('POST', u, b, h),
    put: (u, b, h) => request('PUT', u, b, h),
    del: (u, b, h) => request('DELETE', u, b, h),
    /** Log in and remember the token for subsequent calls. */
    async login(username = 'admin', password = 'admin123') {
      const res = await request('POST', '/api/auth/login', { username, password });
      token = res.body && res.body.token;
      return res;
    },
    setToken(t) { token = t; },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      try { connection._db.close(); } catch (_) {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    },
  };
}

module.exports = { startTestApp };
