// Pratinjau mockup (redesain v2, P2-2 dan P2-3): Tema Terang / Gelap / Sistem, Teks 100 % / 200 %, Ponsel / Tablet.
// Satu-satunya JavaScript di mockup; tanpa skrip ini halaman tetap tampil terang, teks 100 %, ponsel 360 dp.
// Memasang atribut di <html> sebelum halaman digambar (dimuat di <head>): data-theme="light|dark", data-ts="1|2",
// data-device="phone|tablet"; lalu menambahkan grup tombol ke strip kepala (.page-header__nav). Pilihan disimpan di
// localStorage browser ini saja; ?theme=dark|light|system, ?ts=1|2 dan ?device=phone|tablet di URL menimpanya
// (berguna untuk tautan dan tangkapan layar).
(() => {
  const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const CONTROLS = [
    {
      param: 'theme',
      key: 'kapdh-mockup-theme',
      label: 'Tema mockup',
      fallback: 'light',
      options: [['light', 'Terang'], ['dark', 'Gelap'], ['system', 'Sistem']],
      apply: (v) => {
        const dark = v === 'dark' || (v === 'system' && media?.matches);
        document.documentElement.dataset.theme = dark ? 'dark' : 'light';
      },
    },
    {
      param: 'ts',
      key: 'kapdh-mockup-ts',
      label: 'Skala teks',
      fallback: '1',
      options: [['1', 'Teks 100 %'], ['2', '200 %']],
      apply: (v) => { document.documentElement.dataset.ts = v; },
    },
    {
      param: 'device',
      key: 'kapdh-mockup-device',
      label: 'Ukuran perangkat',
      fallback: 'phone',
      options: [['phone', 'Ponsel'], ['tablet', 'Tablet']],
      apply: (v) => { document.documentElement.dataset.device = v; },
    },
  ];

  const read = (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const save = (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Penyimpanan diblokir (mode privat): pilihan berlaku untuk halaman ini saja.
    }
  };

  const url = new URLSearchParams(location.search);
  const state = {};
  for (const c of CONTROLS) {
    const valid = (v) => c.options.some(([o]) => o === v);
    const fromUrl = url.get(c.param);
    const saved = read(c.key);
    state[c.param] = valid(fromUrl) ? fromUrl : valid(saved) ? saved : c.fallback;
    c.apply(state[c.param]);
  }
  media?.addEventListener?.('change', () => state.theme === 'system' && CONTROLS[0].apply('system'));

  const mount = () => {
    const nav = document.querySelector('.page-header__nav');
    if (!nav || nav.querySelector('.preview-controls')) return;
    const wrap = document.createElement('div');
    wrap.className = 'preview-controls';
    for (const c of CONTROLS) {
      const group = document.createElement('div');
      group.className = 'theme-toggle';
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', c.label);
      for (const [value, text] of c.options) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = text;
        button.setAttribute('aria-pressed', String(state[c.param] === value));
        button.addEventListener('click', () => {
          state[c.param] = value;
          save(c.key, value);
          c.apply(value);
          for (const b of group.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === button));
        });
        group.append(button);
      }
      wrap.append(group);
    }
    nav.append(wrap);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
