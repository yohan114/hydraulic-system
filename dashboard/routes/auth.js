'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const connection = require('../db');
const sql = require('../lib/sql');
const authLib = require('../lib/auth');
const router = express.Router();

const AUTH_ENABLED = process.env.BILLING_AUTH !== 'off';
const TOKEN_TTL_SECONDS = 12 * 60 * 60;

// The three roles, most→least privileged. Anything unrecognised is treated as
// the built-in admin (covers legacy rows created before roles existed).
const ROLES = ['admin', 'cashier', 'viewer'];
function normaliseRole(r) { return ROLES.includes(r) ? r : 'admin'; }

// Persisted signing secret. Lives one level up from routes/ (repo dashboard/).
// NOTE: this constant was lost when server.js was split into routers, so the
// reference below silently threw (caught by the surrounding try/catch) and a
// FRESH random secret was minted on every boot — invalidating every token on
// restart. Defining it fixes token persistence across restarts.
const SECRET_FILE = path.join(__dirname, '..', '.auth-secret');

function loadOrCreateSecret() {
    if (process.env.BILLING_SECRET) return process.env.BILLING_SECRET;
    try {
        if (fs.existsSync(SECRET_FILE)) {
            const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
            if (s) return s;
        }
    } catch (_) {}
    const secret = crypto.randomBytes(48).toString('hex');
    try { fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 }); } catch (_) {}
    return secret;
}
const AUTH_SECRET = loadOrCreateSecret();

// Fallback password used when no user has been provisioned in the Users table.
const DEFAULT_USERNAME = 'admin';
const FALLBACK_PASSWORD = process.env.BILLING_PASSWORD || 'admin123';

// Whether the Users table has been provisioned with at least one credential.
// Returns { provisioned, tableMissing }. tableMissing is true only when the
// Users table does not exist yet (fresh, un-migrated database).

async function provisioningState() {
    try {
        const rows = await connection.query('SELECT COUNT(*) AS c FROM Users');
        return { provisioned: ((rows[0] && rows[0].c) || 0) > 0, tableMissing: false };
    } catch (_) {
        return { provisioned: false, tableMissing: true };
    }
}

// Whether at least one user row exists (used to warn about the default password).
async function hasProvisionedUser() {
    const state = await provisioningState();
    return state.provisioned;
}

// Returns { ok, username } after checking credentials.
//
// Security policy (fails CLOSED):
//   - Once ANY user exists, only stored (hashed) credentials are accepted; the
//     built-in default is disabled and a lookup error denies access rather than
//     falling back to it.
//   - The default admin/admin123 is accepted ONLY to bootstrap a database that
//     has no users yet (empty or un-migrated Users table).
async function checkCredentials(username, password) {
    const uname = String(username || '').trim() || DEFAULT_USERNAME;
    const { provisioned } = await provisioningState();

    if (provisioned) {
        try {
            const rows = await connection.query(
                `SELECT PasswordHash, Role FROM Users WHERE Username = ${sql.q(uname)}`
            );
            if (rows.length > 0 && rows[0].PasswordHash) {
                const ok = await authLib.verifyPassword(password, rows[0].PasswordHash);
                return { ok, username: uname, role: normaliseRole(rows[0].Role) };
            }
        } catch (_) {
            // Fall through and deny — never re-enable the default on an error.
        }
        return { ok: false, username: uname, role: null }; // unknown user / lookup failed -> deny
    }

    // No users provisioned yet: allow the bootstrap default so setup is possible.
    const ok = uname === DEFAULT_USERNAME && String(password) === FALLBACK_PASSWORD;
    return { ok, username: uname, role: 'admin' };
}


function extractToken(req) {
    const header = req.headers['authorization'] || '';
    if (header.startsWith('Bearer ')) return header.slice(7).trim();
    return null;
}

// Simple in-memory login throttle: cap attempts per client IP in a fixed
// window so credentials can't be brute-forced (and a burst can't pile up scrypt
// work). This is best-effort protection for a single-process local deployment.
const LOGIN_WINDOW_MS = 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 15;
const loginAttempts = new Map(); // ip -> { count, resetAt }

function loginThrottleExceeded(ip) {
    const now = Date.now();
    const rec = loginAttempts.get(ip);
    if (!rec || now > rec.resetAt) {
        loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
        return false;
    }
    rec.count += 1;
    return rec.count > LOGIN_MAX_ATTEMPTS;
}

// Gate mounted on /api (after the public auth routes below).

function requireAuth(req, res, next) {
    if (!AUTH_ENABLED) return next();
    const token = extractToken(req);
    const claims = token ? authLib.verifyToken(token, AUTH_SECRET) : null;
    if (!claims) {
        return res.status(401).json({ error: 'Authentication required', code: 'UNAUTHENTICATED' });
    }
    req.user = claims;
    next();
}

// Effective role for a request. With auth OFF (dev) everything runs as admin;
// a token without a role (issued before roles) is also treated as admin.
function roleOf(req) {
    if (!AUTH_ENABLED) return 'admin';
    return normaliseRole(req.user && req.user.role);
}

// Gate a route to specific roles. Returns 403 for anyone else.
function requireRole(...roles) {
    return (req, res, next) => {
        if (roles.includes(roleOf(req))) return next();
        return res.status(403).json({ error: 'You do not have permission for this action.', code: 'FORBIDDEN' });
    };
}

// Global write guard: a viewer may only READ. GETs and the public/self-service
// auth endpoints pass; every other method for a viewer is refused. Mounted once
// in server.js right after the auth gate (so req.user is populated).
function viewerReadOnlyGuard(req, res, next) {
    if (!AUTH_ENABLED) return next();
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (req.path.startsWith('/api/auth/')) return next(); // login/status/change-password
    if (roleOf(req) === 'viewer') {
        return res.status(403).json({ error: 'Viewers have read-only access.', code: 'FORBIDDEN' });
    }
    next();
}

// --- Public auth endpoints ---

router.post('/api/auth/login', async (req, res) => {
    try {
        const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
        if (loginThrottleExceeded(ip)) {
            return res.status(429).json({ error: 'Too many login attempts. Please wait a minute and try again.' });
        }
        const { username, password } = req.body || {};
        if (!password) return res.status(400).json({ error: 'Password is required' });
        const result = await checkCredentials(username, password);
        if (!result.ok) return res.status(401).json({ error: 'Invalid username or password' });
        const role = normaliseRole(result.role);
        const token = authLib.createToken({ sub: result.username, role }, AUTH_SECRET, TOKEN_TTL_SECONDS);
        res.json({ token, username: result.username, role, expiresIn: TOKEN_TTL_SECONDS });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


router.get('/api/auth/status', async (req, res) => {
    const token = extractToken(req);
    const claims = token ? authLib.verifyToken(token, AUTH_SECRET) : null;
    res.json({
        authEnabled: AUTH_ENABLED,
        authenticated: !!claims || !AUTH_ENABLED,
        username: claims ? claims.sub : null,
        role: AUTH_ENABLED ? (claims ? normaliseRole(claims.role) : null) : 'admin',
        usingDefaultPassword: AUTH_ENABLED ? !(await hasProvisionedUser()) : false,
    });
});


router.post('/api/auth/change-password', async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body || {};
        if (!newPassword || String(newPassword).length < 4) {
            return res.status(400).json({ error: 'New password must be at least 4 characters' });
        }
        const username = (req.user && req.user.sub) || DEFAULT_USERNAME;
        const check = await checkCredentials(username, currentPassword);
        if (!check.ok) return res.status(401).json({ error: 'Current password is incorrect' });

        const hash = await authLib.hashPassword(newPassword);
        const existing = await connection.query(`SELECT UserID FROM Users WHERE Username = ${sql.q(username)}`);
        if (existing.length > 0) {
            await connection.execute(
                `UPDATE Users SET PasswordHash = ${sql.q(hash)}, UpdatedAt = Now() WHERE Username = ${sql.q(username)}`
            );
        } else {
            await connection.execute(
                `INSERT INTO Users (Username, PasswordHash, Role, CreatedAt, UpdatedAt)
                 VALUES (${sql.q(username)}, ${sql.q(hash)}, 'admin', Now(), Now())`
            );
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Could not change password. Run "npm run migrate" first. ' + err.message });
    }
});


module.exports = {
    router, requireAuth, requireRole, viewerReadOnlyGuard, roleOf,
    hasProvisionedUser, AUTH_ENABLED, FALLBACK_PASSWORD, ROLES,
};
