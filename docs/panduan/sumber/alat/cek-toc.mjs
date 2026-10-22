// Cocokkan nomor halaman di daftar isi dengan halaman tempat judul bab/subbab tercetak.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch } from './common.mjs';
const html = process.argv[2];
const b = await launch(['--allow-file-access-from-files']);
const p = await b.newPage();
await p.goto(pathToFileURL(html).href); await p.evaluate(() => document.fonts.ready);
await p.evaluate(async () => { await window.PagedPolyfill.preview(); });
const r = await p.evaluate(() => {
  const pageOf = el => Number(el.closest('.pagedjs_page')?.dataset.pageNumber);
  const out = { ok: 0, bad: [], orphanH2: [], headRepeat: 0 };
  for (const a of document.querySelectorAll('.toc a')) {
    const id = a.getAttribute('href').slice(1);
    const target = document.querySelector(`[data-id="${id}"], #${CSS.escape(id)}`);
    // Paged.js menyelesaikan target-counter dengan counter-reset pada elemen tautan
    const cr = getComputedStyle(a).counterReset; const shown = (cr.match(/(\d+)\s*$/) || [])[1] || cr;
    const actual = target ? pageOf(target) : NaN;
    if (String(actual) === shown) out.ok++; else out.bad.push(`${id}: daftar isi ${shown}, sebenarnya ${actual}`);
  }
  // judul subbab yang menjadi elemen terakhir di halaman
  for (const pg of document.querySelectorAll('.pagedjs_page')) {
    const area = pg.querySelector('.pagedjs_page_content'); if (!area) continue;
    const hs = area.querySelectorAll('h2, h4.blk-title');
    const bottom = area.getBoundingClientRect().bottom;
    for (const h of hs) { const hb = h.getBoundingClientRect(); const after = [...area.querySelectorAll('*')].some(e => { const rb = e.getBoundingClientRect(); return rb.top > hb.bottom + 1 && rb.height > 0 && !h.contains(e); }); if (!after) out.orphanH2.push(`hal ${pg.dataset.pageNumber}: ${h.textContent.slice(0, 50)}`); }
  }
  out.headRepeat = document.querySelectorAll('table[data-repeated-header]').length;
  return out;
});
console.log(`daftar isi cocok: ${r.ok}, tidak cocok: ${r.bad.length}`); r.bad.slice(0, 30).forEach(x => console.log('  ' + x));
console.log(`judul yatim: ${r.orphanH2.length}`); r.orphanH2.forEach(x => console.log('  ' + x));
console.log(`tabel dengan kepala diulang: ${r.headRepeat}`);
await b.close();
