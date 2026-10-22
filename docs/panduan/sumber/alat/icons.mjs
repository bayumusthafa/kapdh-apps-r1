// Ikon Phosphor (subset aplikasi) sebagai SVG inline, diambil dari CSS mockup yang dibangkitkan.
import fs from 'node:fs';

export function loadIcons(cssPath) {
  const css = fs.readFileSync(cssPath, 'utf8');
  const map = new Map();
  for (const m of css.matchAll(/\.(ph-[a-z0-9-]+)\{--ic:url\("data:image\/svg\+xml,(.*?)"\)\}/g)) {
    let svg = decodeURIComponent(m[2].replace(/'/g, '"'));
    svg = svg.replace(/fill="%23000"|fill="#000"/g, 'fill="currentColor"');
    map.set(m[1], svg);
  }
  return map;
}

export function iconSvg(map, name, cls = 'ic') {
  const svg = map.get(name) || map.get('ph-info');
  return svg.replace('<svg ', `<svg class="${cls}" aria-hidden="true" `);
}
