// Lembar kontak halaman: node montage.mjs <folder-png> <keluaran-prefix> [kolom=6] [per-lembar=24] [lebar-thumb=260]
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
const [dir, prefix, cols = 6, per = 24, tw = 260] = process.argv.slice(2);
const files = fs.readdirSync(dir).filter(f => /\.png$/i.test(f)).sort((a, b) => parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/)));
for (let s = 0; s * per < files.length; s++) {
  const batch = files.slice(s * per, s * per + Number(per));
  const meta = await sharp(path.join(dir, batch[0])).metadata();
  const th = Math.round(meta.height * tw / meta.width);
  const rows = Math.ceil(batch.length / cols), gap = 14, lab = 22;
  const W = cols * (Number(tw) + gap) + gap, H = rows * (th + gap + lab) + gap;
  const comps = [];
  for (let i = 0; i < batch.length; i++) {
    const x = gap + (i % cols) * (Number(tw) + gap), y = gap + Math.floor(i / cols) * (th + gap + lab);
    comps.push({ input: await sharp(path.join(dir, batch[i])).resize(Number(tw), th).png().toBuffer(), left: x, top: y + lab });
    comps.push({ input: Buffer.from(`<svg width="${tw}" height="${lab}"><text x="0" y="16" font-family="Segoe UI" font-size="15" fill="#333">${batch[i]}</text></svg>`), left: x, top: y });
  }
  const out = `${prefix}-${s + 1}.png`;
  await sharp({ create: { width: W, height: H, channels: 3, background: '#9aa39a' } }).composite(comps).png().toFile(out);
  console.log(out);
}
