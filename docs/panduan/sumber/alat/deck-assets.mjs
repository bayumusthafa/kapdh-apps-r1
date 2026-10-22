// Aset gambar presentasi (latar, bingkai ponsel/browser, ikon, QR) dirender lewat Chrome agar konsisten dengan PDF.
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { launch, MOCKUP } from './common.mjs';
import { loadIcons, iconSvg } from './icons.mjs';

const ICONS = loadIcons(MOCKUP + '/css/icons-phosphor.css');
const toData = p => 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');

export async function createRenderer() {
  const browser = await launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  let queue = Promise.resolve();
  // satu halaman dipakai bergantian: render berurutan agar tangkapan tidak tertukar
  function render(html, w, h, out, opts = {}) { const p = queue.then(() => renderNow(html, w, h, out, opts)); queue = p.catch(() => {}); return p; }
  async function renderNow(html, w, h, out, { transparent = false } = {}) {
    if (fs.existsSync(out) && !process.env.REBUILD_ASSETS) return out;
    await page.setViewportSize({ width: w, height: h });
    await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:${transparent ? 'transparent' : '#fff'}}</style></head><body>${html}</body></html>`);
    await page.waitForTimeout(50);
    await page.screenshot({ path: out, omitBackground: transparent, clip: { x: 0, y: 0, width: w, height: h }, scale: 'css' });
    return out;
  }
  async function close() { await browser.close(); }
  return { render, close, page };
}

const ARCS = (color, a) => `<svg viewBox="0 0 1920 1080" width="1920" height="1080" style="position:absolute;inset:0" xmlns="http://www.w3.org/2000/svg">
  <g fill="none" stroke="${color}" stroke-opacity="${a}" stroke-width="64">
    ${[300, 440, 580, 720].map(r => `<circle cx="1920" cy="0" r="${r}"/>`).join('')}
    ${[260, 400, 540].map(r => `<circle cx="0" cy="1080" r="${r}"/>`).join('')}
  </g></svg>`;

export async function backgrounds(R, dir) {
  const dark = await R.render(`<div style="position:absolute;inset:0;background:radial-gradient(90% 90% at 80% 15%,#1E5A1A 0%,#0F2D0D 52%,#0A1F09 100%)"></div>${ARCS('#FFFFFF', 0.045)}`, 1920, 1080, path.join(dir, 'bg-gelap.png'));
  const light = await R.render(`<div style="position:absolute;inset:0;background:#FBFCFA"></div>
    <svg viewBox="0 0 1920 1080" width="1920" height="1080" style="position:absolute;inset:0"><g fill="none" stroke="#1A4B17" stroke-opacity=".045" stroke-width="56">${[220, 340, 460].map(r => `<circle cx="1920" cy="1080" r="${r}"/>`).join('')}</g></svg>`, 1920, 1080, path.join(dir, 'bg-terang.png'));
  return { dark, light };
}

// Bingkai ponsel dengan layar dari tangkapan mockup; latar transparan, bayangan lembut.
export async function phone(R, src, out) {
  const img = toData(src);
  const buf = fs.readFileSync(src); const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  const sw = 720, sh = Math.round(h * sw / w);
  const pad = 26, m = 60;
  const W = sw + pad * 2 + m * 2, H = Math.min(sh, 1700) + pad * 2 + m * 2;
  return R.render(`<div style="position:absolute;left:${m}px;top:${m - 16}px;width:${sw + pad * 2}px;height:${Math.min(sh, 1700) + pad * 2}px;box-sizing:border-box;padding:${pad}px;background:#121511;border-radius:96px;box-shadow:0 0 0 5px #3A3E36,0 34px 60px rgba(0,0,0,.35)">
      <div style="width:${sw}px;height:${Math.min(sh, 1700)}px;border-radius:72px;overflow:hidden;background:#F5F7F3"><img src="${img}" style="display:block;width:${sw}px"></div></div>`, W, H, out, { transparent: true });
}

// Bingkai browser untuk tangkapan web admin/situs.
export async function browserFrame(R, src, out, host) {
  const img = toData(src);
  const buf = fs.readFileSync(src); const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  const sw = 1600, sh = Math.round(h * sw / w), bar = 64, m = 40;
  const lock = iconSvg(ICONS, 'ph-lock-simple-fill').replace('<svg ', '<svg width="22" height="22" style="color:#2D7A28" ');
  return R.render(`<div style="position:absolute;left:${m}px;top:${m - 12}px;width:${sw}px;border-radius:22px;overflow:hidden;background:#fff;box-shadow:0 0 0 2px #D5DCD1,0 26px 50px rgba(14,40,12,.22)">
      <div style="height:${bar}px;background:#EEF1EC;display:flex;align-items:center;gap:26px;padding:0 28px;border-bottom:2px solid #D5DCD1;font-family:'Segoe UI',sans-serif">
        <span style="display:flex;gap:12px"><i style="width:18px;height:18px;border-radius:50%;background:#E5867E"></i><i style="width:18px;height:18px;border-radius:50%;background:#E7C35E"></i><i style="width:18px;height:18px;border-radius:50%;background:#7BBF73"></i></span>
        <span style="display:flex;align-items:center;gap:10px;background:#fff;border-radius:40px;padding:8px 22px;font-size:22px;color:#5E665C;width:560px">${lock}${host}</span></div>
      <img src="${img}" style="display:block;width:${sw}px;height:${sh}px"></div>`, sw + m * 2, sh + bar + m * 2, out, { transparent: true });
}

export async function icon(R, name, color, out, size = 256) {
  const svg = iconSvg(ICONS, name).replace('<svg ', `<svg width="${size}" height="${size}" style="color:${color};display:block" `);
  return R.render(svg, size, size, out, { transparent: true });
}

export async function qr(url, out) {
  await QRCode.toFile(out, url, { width: 900, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0E280C', light: '#FFFFFF' } });
  return out;
}
