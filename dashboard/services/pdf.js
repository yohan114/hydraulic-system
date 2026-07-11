'use strict';

/**
 * HTML → PDF via headless Chromium (puppeteer).
 *
 * puppeteer is an OPTIONAL dependency: the whole app must still boot and print
 * via the browser dialog if it isn't installed. So it is required lazily here
 * and {@link isAvailable} lets callers return a graceful 501 instead of a crash.
 *
 * Resolution order for the browser engine:
 *   1. `puppeteer` (bundles its own Chromium — the normal install)
 *   2. `puppeteer-core` (no bundled browser; needs an executable path)
 * and the executable is taken from PUPPETEER_EXECUTABLE_PATH when set (also lets
 * puppeteer-core reuse a system Chrome/Chromium).
 */

let _pptr;
function getPuppeteer() {
  if (_pptr !== undefined) return _pptr;
  try { _pptr = require('puppeteer'); }
  catch (_) {
    try { _pptr = require('puppeteer-core'); }
    catch (_2) { _pptr = null; }
  }
  return _pptr;
}

function isAvailable() { return !!getPuppeteer(); }

/**
 * Render an HTML string to an A4 PDF buffer.
 * @param {string} html self-contained HTML (inline CSS, embedded assets)
 * @returns {Promise<Buffer>}
 */
async function htmlToPdf(html) {
  const puppeteer = getPuppeteer();
  if (!puppeteer) throw new Error('PDF engine not installed (run: npm install puppeteer)');

  const launchOpts = { args: ['--no-sandbox', '--disable-setuid-sandbox'] };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;

  const browser = await puppeteer.launch(launchOpts);
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' },
    });
  } finally {
    await browser.close();
  }
}

module.exports = { htmlToPdf, isAvailable };
