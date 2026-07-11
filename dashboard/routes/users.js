'use strict';

/**
 * User management — admin-only CRUD over the Users table (username, role and
 * password). Roles: admin (full access), cashier (billing but no cost/price or
 * catalogue admin) and viewer (read-only). Enforcement of what each role may do
 * lives in the route guards; this module just maintains the accounts.
 */

const express = require('express');
const connection = require('../db');
const sql = require('../lib/sql');
const authLib = require('../lib/auth');
const { requireRole, ROLES, FALLBACK_PASSWORD } = require('./auth');
const router = express.Router();

// Every endpoint here is admin-only.
router.use(requireRole('admin'));

function validRole(r) { return ROLES.includes(r); }

// Once ANY user row exists, the built-in default admin login is disabled. So if
// an admin who is still on the default password (no admin row yet) adds a user,
// we must first persist their admin account — otherwise the default stops
// working and there is no admin left to log in as (a lock-out). This bakes in
// the current default password, which the admin can change afterwards.
async function ensureBootstrapAdmin(req) {
    const admins = await connection.query("SELECT COUNT(*) AS c FROM Users WHERE Role = 'admin'");
    if ((admins[0] && admins[0].c) > 0) return;
    const name = (req.user && req.user.sub) || 'admin';
    const exists = await connection.query(`SELECT UserID FROM Users WHERE Username = ${sql.q(name)}`);
    if (exists.length > 0) {
        await connection.execute(`UPDATE Users SET Role = 'admin', UpdatedAt = Now() WHERE Username = ${sql.q(name)}`);
        return;
    }
    const hash = await authLib.hashPassword(FALLBACK_PASSWORD);
    await connection.execute(
        `INSERT INTO Users (Username, PasswordHash, Role, CreatedAt, UpdatedAt) VALUES (${sql.q(name)}, ${sql.q(hash)}, 'admin', Now(), Now())`
    );
}

router.get('/api/users', async (req, res) => {
    try {
        const rows = await connection.query('SELECT UserID, Username, Role, CreatedAt, UpdatedAt FROM Users ORDER BY Username');
        res.json(rows.map((u) => ({ ...u, Role: validRole(u.Role) ? u.Role : 'admin' })));
    } catch (err) {
        res.status(500).json({ error: 'Could not load users. Run "npm run migrate" first. ' + err.message });
    }
});

router.post('/api/users', async (req, res) => {
    try {
        const { username, password, role } = req.body || {};
        const uname = String(username || '').trim();
        if (!uname) return res.status(400).json({ error: 'Username is required' });
        if (!password || String(password).length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
        if (!validRole(role)) return res.status(400).json({ error: 'Role must be admin, cashier or viewer' });

        const existing = await connection.query(`SELECT UserID FROM Users WHERE Username = ${sql.q(uname)}`);
        if (existing.length > 0) return res.status(400).json({ error: 'A user with that name already exists' });

        await ensureBootstrapAdmin(req);

        const hash = await authLib.hashPassword(password);
        await connection.execute(
            `INSERT INTO Users (Username, PasswordHash, Role, CreatedAt, UpdatedAt)
             VALUES (${sql.q(uname)}, ${sql.q(hash)}, ${sql.q(role)}, Now(), Now())`
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/api/users/:id', async (req, res) => {
    try {
        const id = sql.n(req.params.id);
        const { role, newPassword } = req.body || {};
        const target = await connection.query(`SELECT UserID, Role FROM Users WHERE UserID = ${id}`);
        if (target.length === 0) return res.status(404).json({ error: 'User not found' });

        // Never let the last admin be demoted, or there would be no way back in.
        if (role && validRole(role) && target[0].Role === 'admin' && role !== 'admin') {
            const admins = await connection.query("SELECT COUNT(*) AS c FROM Users WHERE Role = 'admin'");
            if ((admins[0] && admins[0].c) <= 1) return res.status(400).json({ error: 'Cannot demote the last administrator.' });
        }

        const sets = [];
        if (role !== undefined) {
            if (!validRole(role)) return res.status(400).json({ error: 'Role must be admin, cashier or viewer' });
            sets.push(`Role = ${sql.q(role)}`);
        }
        if (newPassword) {
            if (String(newPassword).length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
            const hash = await authLib.hashPassword(newPassword);
            sets.push(`PasswordHash = ${sql.q(hash)}`);
        }
        if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
        sets.push('UpdatedAt = Now()');
        await connection.execute(`UPDATE Users SET ${sets.join(', ')} WHERE UserID = ${id}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/api/users/:id', async (req, res) => {
    try {
        const id = sql.n(req.params.id);
        const target = await connection.query(`SELECT UserID, Username, Role FROM Users WHERE UserID = ${id}`);
        if (target.length === 0) return res.status(404).json({ error: 'User not found' });

        // Don't allow deleting yourself or the last admin (lock-out protection).
        if (req.user && req.user.sub === target[0].Username) {
            return res.status(400).json({ error: 'You cannot delete your own account.' });
        }
        if (target[0].Role === 'admin') {
            const admins = await connection.query("SELECT COUNT(*) AS c FROM Users WHERE Role = 'admin'");
            if ((admins[0] && admins[0].c) <= 1) return res.status(400).json({ error: 'Cannot delete the last administrator.' });
        }
        await connection.execute(`DELETE FROM Users WHERE UserID = ${id}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
