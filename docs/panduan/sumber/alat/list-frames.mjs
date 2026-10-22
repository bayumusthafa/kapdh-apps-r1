// Pemakaian: node list-frames.mjs <grup/halaman.html>   -> daftar frame (nomor urut, label, tinggi) pada halaman mockup
import { launch, MOCKUP } from './common.mjs';
import { pathToFileURL } from 'node:url';
const [page] = process.argv.slice(2);
const b = await launch(); const p = await b.newPage({ viewport: { width: 1400, height: 1000 } });
await p.goto(pathToFileURL(MOCKUP + '/' + page).href);
const frames = await p.$$eval('figure.frame', fs => fs.map((f, i) => ({ n: i + 1, label: f.querySelector('.frame__label')?.textContent.trim().replace(/\s+/g, ' '), h: Math.round(f.querySelector('.device')?.getBoundingClientRect().height || 0) })));
for (const f of frames) console.log(`#${f.n}\t${f.label}\t(tinggi ${f.h}px)`);
await b.close();
