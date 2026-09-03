/**
 * The modules the GUI imports at runtime via `/lib/<name>.js`.
 *
 * Single source of truth for three things that must agree:
 *   - src/server.js   serves these from src/ when running locally
 *   - tools/build-site.js  copies them into docs/app/lib for Pages
 *   - test/site.test.js    asserts the copies match src/ byte for byte
 *
 * Every entry must be browser-safe: no Node built-ins, no Node globals.
 */
export const BROWSER_MODULES = ['xml.js', 'feed.js', 'hosted.js', 'opml.js'];
