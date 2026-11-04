// tests/chrome-launch.test.mjs — every browser that opens a web page uses the
// installed Google Chrome with its sandbox on.
//
// Playwright's bundled Chromium only moves when Playwright is upgraded, and it
// launches with Chrome's sandbox off. lib/chrome-launch.mjs adds
// `channel: 'chrome'` and `chromiumSandbox: true` to the caller's options. The
// guard at the end fails on any new bare `chromium.launch(` in a tracked .mjs
// file, so an upstream merge cannot bring the old browser back unseen.
import { pass, fail, ROOT } from './helpers.mjs';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nchrome-launch — job-page browsers use Google Chrome with its sandbox on');

// Launches left on the bundled Chromium on purpose. The two PDF scripts render
// local files with JavaScript off and every non-file request blocked; the tests
// render local fixtures or use a fake browser.
const ALLOWED = new Set(['lib/chrome-launch.mjs', 'generate-pdf.mjs', 'img-to-pdf.mjs', 'test-all.mjs']);
const isAllowed = (file) => ALLOWED.has(file) || file.startsWith('tests/');

try {
  const modulePath = join(ROOT, 'lib/chrome-launch.mjs');
  const { chromeLaunchOptions } = await import(pathToFileURL(modulePath).href);

  const opts = chromeLaunchOptions({ headless: false, args: ['--window-size=1280,940'] });
  opts.channel === 'chrome' ? pass("options carry channel: 'chrome'") : fail(`channel => ${opts.channel}`);
  opts.chromiumSandbox === true ? pass('options carry chromiumSandbox: true') : fail(`chromiumSandbox => ${opts.chromiumSandbox}`);
  opts.headless === false && JSON.stringify(opts.args) === '["--window-size=1280,940"]'
    ? pass("the caller's headless and args survive")
    : fail(`headless/args changed => ${JSON.stringify(opts)}`);

  const input = { headless: true };
  chromeLaunchOptions(input);
  JSON.stringify(input) === '{"headless":true}'
    ? pass("the caller's options object is not modified")
    : fail(`input mutated => ${JSON.stringify(input)}`);

  const bare = chromeLaunchOptions();
  bare.channel === 'chrome' && bare.chromiumSandbox === true
    ? pass('no options still gives Chrome with its sandbox on')
    : fail(`no-argument call => ${JSON.stringify(bare)}`);

  // Importing must launch nothing and check nothing, so a missing Chrome can
  // never stop a scan at start. The module imports nothing at all.
  const code = readFileSync(modulePath, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  !/^\s*import\s/m.test(code) && !/\bimport\(/.test(code) && !/\.launch\(/.test(code)
    ? pass('importing the module launches nothing (it imports nothing and calls no launch)')
    : fail('lib/chrome-launch.mjs imports a module or calls launch()');

  // Guard: no bare chromium.launch( outside the allow-list. Comment lines are
  // skipped; a launch wrapped in chromeLaunchOptions( is the moved form. A line
  // marked "// bundled-chromium:" is a deliberate check of the bundled browser
  // (doctor.mjs, for the PDF renders) and says why on the line itself.
  const tracked = execFileSync('git', ['ls-files', '*.mjs'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean);
  const offenders = [];
  for (const file of tracked) {
    if (isAllowed(file)) continue;
    let text;
    try { text = readFileSync(join(ROOT, file), 'utf8'); } catch { continue; }
    text.split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line) || /\/\/ bundled-chromium:/.test(line)) return;
      if (/chromium\.launch\((?!chromeLaunchOptions\()/.test(line)) offenders.push(`${file}:${i + 1}`);
    });
  }
  offenders.length === 0
    ? pass(`no bare chromium.launch( in ${tracked.length} tracked .mjs files outside the allow-list`)
    : fail(`bare chromium.launch( outside lib/chrome-launch.mjs: ${offenders.join(', ')}`);
} catch (e) {
  fail(`chrome-launch tests crashed: ${e.message}`);
}
