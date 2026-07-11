'use strict';

/**
 * Authentication primitives (password hashing + stateless signed tokens).
 *
 * Built entirely on Node's `crypto` module — no external dependencies — so the
 * logic is testable on any platform and adds nothing to the install footprint.
 * The dashboard runs locally, so this is a lightweight "lock" to stop anyone
 * without the password from creating/editing invoices, not a full IAM system.
 */

const crypto = require('crypto');
const { promisify } = require('util');

const SCRYPT_KEYLEN = 64;

// Async scrypt so password derivation runs on the libuv thread pool instead of
// blocking the single Node event loop (a burst of login attempts must not be
// able to stall the whole server).
const scryptAsync = promisify(crypto.scrypt);

/**
 * Hash a password with a random per-password salt using scrypt.
 * @param {string} password
 * @returns {Promise<string>} encoded as "scrypt$<saltHex>$<hashHex>"
 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scryptAsync(String(password), salt, SCRYPT_KEYLEN)).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

/**
 * Verify a password against a stored hash in constant time.
 * @param {string} password
 * @param {string} stored value produced by {@link hashPassword}
 * @returns {Promise<boolean>}
 */
async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hashHex] = parts;
  let derived;
  try {
    derived = await scryptAsync(String(password), salt, SCRYPT_KEYLEN);
  } catch {
    return false;
  }
  const expected = Buffer.from(hashHex, 'hex');
  if (expected.length !== derived.length) return false;
  return crypto.timingSafeEqual(expected, derived);
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBuf(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/**
 * Create a signed, expiring token: "<payloadB64url>.<hmacB64url>".
 * @param {object} payload arbitrary claims (a `sub`/username is typical)
 * @param {string} secret server signing secret
 * @param {number} [ttlSeconds=43200] lifetime (default 12h)
 * @param {number} [nowMs=Date.now()] injectable clock for testing
 * @returns {string}
 */
function createToken(payload, secret, ttlSeconds = 43200, nowMs = Date.now()) {
  const body = { ...payload, iat: Math.floor(nowMs / 1000), exp: Math.floor(nowMs / 1000) + ttlSeconds };
  const encoded = b64url(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest();
  return `${encoded}.${b64url(sig)}`;
}

/**
 * Verify and decode a token. Returns the claims, or null if invalid/expired.
 * @param {string} token
 * @param {string} secret
 * @param {number} [nowMs=Date.now()] injectable clock for testing
 * @returns {object|null}
 */
function verifyToken(token, secret, nowMs = Date.now()) {
  if (typeof token !== 'string' || token.indexOf('.') === -1) return null;
  const [encoded, sig] = token.split('.');
  if (!encoded || !sig) return null;

  const expectedSig = crypto.createHmac('sha256', secret).update(encoded).digest();
  const givenSig = b64urlToBuf(sig);
  if (givenSig.length !== expectedSig.length) return null;
  if (!crypto.timingSafeEqual(givenSig, expectedSig)) return null;

  let claims;
  try {
    claims = JSON.parse(b64urlToBuf(encoded).toString('utf8'));
  } catch {
    return null;
  }
  if (!claims || typeof claims.exp !== 'number') return null;
  if (Math.floor(nowMs / 1000) >= claims.exp) return null;
  return claims;
}

module.exports = { hashPassword, verifyPassword, createToken, verifyToken };
