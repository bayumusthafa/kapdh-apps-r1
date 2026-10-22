// Halaman isi bab yang terisi kurang dari ambang (bukan halaman terakhir bab): indikasi ruang kosong besar.
import { pathToFileURL } from 'node:url';
import { launch } from './common.mjs';
const [html, th = '0.62'] = process.argv.slice(2);
const b = await launch(['--allow-file-access-from-files']);
const p = await b.newPage();
await p.goto(pathToFileURL(html).href); await p.evaluate(() => document.fonts.ready);
await p.evaluate(async () => { await window.PagedPolyfill.preview(); });
const r = await p.evaluate((th) => {
  const pages = [...document.querySelectorAll('.pagedjs_page')];
  const res = [];
  pages.forEach((pg, i) => {
    const area = pg.querySelector('.pagedjs_page_content'); if (!area) return;
    const ch = area.querySelector('.chapter'); if (!ch) return;
    const next = pages[i + 1]; const nextIsNewChapter = !next || next.querySelector('.ch-head, .part-div, .back') || !next.querySelector('.chapter');
    if (nextIsNewChapter) return;
    const a = area.getBoundingClientRect(); let maxB = a.top;
    for (const e of area.querySelectorAll('p, li, figure, aside, table, h2, h4, .qa, .st-item, img')) { const r = e.getBoundingClientRect(); if (r.height > 0 && r.bottom > maxB && getComputedStyle(e).visibility !== 'hidden') maxB = r.bottom; }
    const fill = (maxB - a.top) / a.height;
    if (fill < th) res.push({ page: pg.dataset.pageNumber, fill: Math.round(fill * 100) });
  });
  return res;
}, Number(th));
console.log(`halaman terisi < ${Math.round(th * 100)}%: ${r.length}`); console.log(r.map(x => `${x.page}(${x.fill}%)`).join(' '));
await b.close();
