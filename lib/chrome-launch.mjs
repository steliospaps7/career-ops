/**
 * chrome-launch.mjs — launch options for every browser that opens a web page.
 *
 * Playwright's bundled Chromium only moves when Playwright is upgraded, and it
 * runs with Chrome's own sandbox off by default. These scripts open job pages
 * from the open web, so they use the installed Google Chrome instead
 * (`channel: 'chrome'`, which updates itself) with the sandbox on
 * (`chromiumSandbox: true`). Playwright gives the launch a fresh temporary
 * profile, so the user's own Chrome profile is never touched.
 *
 * Deliberately left on the bundled Chromium: `generate-pdf.mjs` and
 * `img-to-pdf.mjs`, which render local files with JavaScript off and every
 * non-file request blocked. `tests/chrome-launch.test.mjs` fails on any other
 * `chromium.launch(` that does not go through this module.
 *
 * This module checks nothing when imported, so a missing Chrome surfaces as a
 * launch error at the call site, never as a crash at start-up.
 */

/**
 * The caller's launch options with Google Chrome and its sandbox added.
 * `headless`, `args` and every other option stay as the caller passed them.
 *
 * @param {object} [options] - Playwright `chromium.launch()` options.
 * @returns {object} A new options object; the input is not modified.
 */
export function chromeLaunchOptions(options = {}) {
  return { ...options, channel: 'chrome', chromiumSandbox: true };
}
