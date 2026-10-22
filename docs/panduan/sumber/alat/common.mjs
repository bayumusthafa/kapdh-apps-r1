import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
// Folder ini: docs/panduan/sumber/alat; root repo empat tingkat di atasnya.
export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WT = path.resolve(HERE, '../../../..').replace(/\\/g, '/');
export const ASSETS = WT + '/docs/panduan/sumber/gambar';
export const MOCKUP = WT + '/kapdh-mobile/mockup-html';
const CHROME_DEFAULTS = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
export const CHROME = process.env.CHROME_PATH || CHROME_DEFAULTS.find(p => fs.existsSync(p));
export async function launch(args = []) { return chromium.launch({ ...(CHROME ? { executablePath: CHROME } : {}), args }); }
export function outPath(sub, name) {
  const base = name.endsWith('.png') ? name : name + '.png';
  const p = path.isAbsolute(base) ? base : path.join(ASSETS, sub, base);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}
export function parseFlags(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; flags[k] = v; }
    else pos.push(a);
  }
  return { pos, flags };
}
export async function runSteps(page, steps) {
  for (const s of steps || []) {
    if (s.click) await page.click(s.click, { timeout: 8000 });
    else if (s.fill) await page.fill(s.fill[0], s.fill[1], { timeout: 8000 });
    else if (s.press) await page.keyboard.press(s.press);
    else if (s.goto) await page.goto(s.goto);
    else if (s.hover) await page.hover(s.hover, { timeout: 8000 });
    else if (s.scroll) await page.locator(s.scroll).first().scrollIntoViewIfNeeded();
    else if (s.select) await page.selectOption(s.select[0], s.select[1]);
    else if (s.check) await page.check(s.check);
    if (s.wait) await page.waitForTimeout(s.wait); else await page.waitForTimeout(400);
  }
}
// Git Bash mengubah argumen "/rute" menjadi path Windows; pulihkan ke rute URL.
export function normRoute(r) {
  if (!r) return '/';
  r = r.split(String.fromCharCode(92)).join('/');
  const m = r.match(/^[A-Za-z]:\/.*?\/git(\/.*)?$/);
  if (m) r = m[1] || '/';
  if (!r.startsWith('/')) r = '/' + r;
  return r;
}
