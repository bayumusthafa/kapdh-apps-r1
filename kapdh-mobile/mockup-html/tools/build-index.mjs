// Membangkitkan index.html (galeri semua halaman layar per grup + tabel cakupan layar Flutter) dari strip kepala
// (.page-header) setiap halaman <grup>/<slug>.html. Tanpa dependensi.
//
// Pakai (dari folder mockup-html):  node tools/build-index.mjs
// Jalankan ulang setelah menambah halaman, mengganti judul/rute/keadaan di strip kepala, atau menambah layar Flutter.
// Skrip juga memeriksa bahwa setiap lib/**/*_screen.dart dan lib/app/app_shell.dart punya halaman mockup.
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const lib = join(root, '..', 'lib');

// Urutan grup dan halaman mengikuti alur pengguna; halaman baru yang belum terdaftar ditaruh di akhir grupnya.
const GROUPS = [
  {
    dir: 'auth',
    title: 'Masuk, pendaftaran, sistem dan status akun',
    dart: 'lib/features/auth, system, onboarding, status',
    order: ['login', 'register', 'otp', 'onboarding-fees', 'forgot-password', 'forgot-otp', 'reset-password', 'splash', 'update-required', 'maintenance', 'not-found', 'config-error', 'restricted', 'deletion-status'],
  },
  {
    dir: 'beranda',
    title: 'Beranda, berita, notifikasi, legal dan navigasi bawah',
    dart: 'lib/app/app_shell.dart, lib/features/home, news, notifications, legal',
    order: ['app-shell', 'home', 'news-list', 'news-detail', 'notifications', 'notification-open', 'legal-page'],
  },
  {
    dir: 'event',
    title: 'Event dan tiket',
    dart: 'lib/features/events, tickets',
    order: ['events', 'event-detail', 'reservation', 'tickets', 'ticket-detail'],
  },
  {
    dir: 'kta',
    title: 'KTA dan pembayaran',
    dart: 'lib/features/kta, payments',
    order: ['kta', 'payments', 'new-payment', 'payment-detail', 'renewal'],
  },
  {
    dir: 'jejaring',
    title: 'Jejaring dan chat',
    dart: 'lib/features/network, chat',
    order: ['network', 'chat-list', 'member-profile', 'report-sheet', 'chat-room', 'chat-info', 'new-group', 'member-picker', 'chat-invitations', 'my-reports', 'blocked-users'],
  },
  {
    dir: 'akun',
    title: 'Akun dan pengaturan',
    dart: 'lib/features/account',
    order: ['account', 'profile-edit', 'privacy', 'notification-preferences', 'sessions', 'change-password', 'delete-account', 'blocked-users', 'my-reports'],
  },
];

const strip = (html) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Isi <dd> disalin apa adanya kecuali tautan (kartu indeks sudah berupa tautan), sehingga <code> tetap.
const ddHtml = (html) => html.replace(/<a\b[^>]*>/g, '').replace(/<\/a>/g, '').replace(/\s+/g, ' ').trim();

function readPage(dir, file) {
  const html = readFileSync(join(root, dir, file), 'utf8');
  const head = html.match(/<header class="page-header">([\s\S]*?)<\/header>/)?.[1] ?? '';
  const title = strip(head.match(/<h1 class="page-header__title">([\s\S]*?)<\/h1>/)?.[1] ?? file);
  const dart = head.match(/<dt>Dart<\/dt>\s*<dd>([\s\S]*?)<\/dd>/)?.[1] ?? '';
  const route = head.match(/<dt>Rute<\/dt>\s*<dd>([\s\S]*?)<\/dd>/)?.[1] ?? '';
  const statesBlock = head.match(/<div class="page-header__states">([\s\S]*?)<\/div>/)?.[1] ?? '';
  const states = [...statesBlock.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => strip(m[1]));
  const frames = (html.match(/<figure class="frame[" ]/g) ?? []).length;
  const firstCode = strip(dart.match(/<code>([\s\S]*?)<\/code>/)?.[1] ?? '');
  return { dir, file, href: `${dir}/${file}`, title, dart, route, states, frames, firstCode, dartText: strip(dart) };
}

const groups = GROUPS.map((g) => {
  const files = existsSync(join(root, g.dir)) ? readdirSync(join(root, g.dir)).filter((f) => f.endsWith('.html')) : [];
  const rank = (f) => { const i = g.order.indexOf(f.replace(/\.html$/, '')); return i < 0 ? 999 : i; };
  files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return { ...g, pages: files.map((f) => readPage(g.dir, f)) };
});
const known = new Set(GROUPS.map((g) => g.dir));
for (const d of readdirSync(root)) {
  if (statSync(join(root, d)).isDirectory() && !['css', 'fonts', 'assets', 'tools', 'js'].includes(d) && !known.has(d)) {
    console.warn(`Peringatan: folder ${d}/ belum terdaftar di GROUPS (tools/build-index.mjs); halamannya tidak masuk indeks.`);
  }
}
const pages = groups.flatMap((g) => g.pages);

// Cakupan: setiap *_screen.dart + app_shell.dart harus disebut di <dd>Dart</dd> sebuah halaman.
const screens = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (f.endsWith('_screen.dart')) screens.push(relative(join(lib, '..'), p).split(sep).join('/')); } };
if (existsSync(lib)) walk(lib);
screens.sort();
screens.unshift('lib/app/app_shell.dart');
const coverage = screens.map((s) => {
  const base = s.split('/').pop();
  let hits = pages.filter((p) => p.dartText.includes(s));
  if (!hits.length) hits = pages.filter((p) => p.dartText.includes(base));
  // Utamakan halaman di grup yang memegang folder fitur layar itu (mis. account/* -> akun, network/* -> jejaring).
  const feature = s.startsWith('lib/features/') ? s.split('/')[2] : base.replace(/\.dart$/, '');
  const home = groups.find((g) => g.dart.split(/[\s,/]+/).includes(feature) || g.dart.includes(base))?.dir;
  const atHome = hits.filter((p) => p.dir === home);
  const pool = atHome.length ? atHome : hits;
  const primary = pool.find((p) => p.firstCode === s) ?? pool.find((p) => p.firstCode.endsWith(base)) ?? pool[0];
  return { s, primary, others: hits.filter((h) => h !== primary) };
});
const missing = coverage.filter((c) => !c.primary);
const primaries = new Set(coverage.map((c) => c.primary).filter(Boolean));
const extras = pages.filter((p) => !primaries.has(p));

const totalFrames = pages.reduce((n, p) => n + p.frames, 0);
const card = (p) => `          <article class="index-card">
            <h3 class="index-card__title"><a href="${p.href}">${esc(p.title)}</a></h3>
            <p class="index-card__file"><code>${p.href}</code> · ${p.frames} frame</p>
            <dl class="index-card__meta">
              <dt>Dart</dt><dd>${ddHtml(p.dart)}</dd>
              <dt>Rute</dt><dd>${ddHtml(p.route)}</dd>
            </dl>
            <ol class="index-card__states" aria-label="Keadaan yang ditampilkan">
${p.states.map((s) => `              <li>${esc(s)}</li>`).join('\n')}
            </ol>
          </article>`;

const covRow = (c) => `            <tr${c.primary ? '' : ' class="is-missing"'}>
              <td><code>${c.s}</code></td>
              <td>${c.primary ? `<a href="${c.primary.href}">${esc(c.primary.title)}</a> <code>${c.primary.href}</code>` : '<strong>Belum ada halaman</strong>'}${c.others.length ? `<br><span class="index-table__also">Juga di: ${c.others.map((o) => `<a href="${o.href}">${o.href}</a>`).join(', ')}</span>` : ''}</td>
              <td>${c.primary ? ddHtml(c.primary.route) : ''}</td>
            </tr>`;

const out = `<!doctype html>
<!-- DIBANGKITKAN oleh tools/build-index.mjs dari strip kepala setiap halaman. Jangan diedit langsung:
     ubah strip kepala halaman atau daftar GROUPS di skrip, lalu jalankan  node tools/build-index.mjs  -->
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mockup KAPDH</title>
  <meta name="description" content="Indeks mockup HTML+CSS statis untuk setiap layar aplikasi Flutter KAPDH.">
  <script src="js/theme.js"></script>
  <link rel="stylesheet" href="css/tokens.css">
  <link rel="stylesheet" href="css/components.css">
</head>
<body>
  <header class="page-header">
    <nav class="page-header__nav" aria-label="Navigasi mockup">
      <a href="components.html">Komponen bersama</a>
      <a href="README.md">README (cara membuka, konvensi, alur redesain)</a>
      <a href="_template.html">Templat halaman</a>
    </nav>
    <h1 class="page-header__title">Mockup HTML aplikasi KAPDH</h1>
    <dl class="page-header__meta">
      <dt>Isi</dt><dd>${pages.length} halaman, ${totalFrames} frame ponsel 360 x 800, ${groups.length} grup</dd>
      <dt>Cakupan</dt><dd>${coverage.length - missing.length} dari ${coverage.length} layar Flutter (${screens.length - 1} <code>*_screen.dart</code> + <code>AppShell</code>)${missing.length ? `, <strong>${missing.length} belum ada halaman</strong>` : ', semuanya punya halaman'}</dd>
      <dt>Sumber</dt><dd><code>kapdh-mobile/lib</code> (Flutter 3.47.2, <code>KapdhTheme.light()</code>)</dd>
    </dl>
    <p class="page-header__note">Tiruan statis tampilan Flutter saat ini sebagai bahan iterasi desain. Setiap halaman berisi satu layar dengan semua keadaan pentingnya (utama, gulir penuh, kosong, galat, memuat, terkunci, dialog, lembar bawah) sebagai frame berlabel. Teks disalin dari Dart; data contoh fiktif. Buka lewat Chrome/Edge atau <code>node tools/serve.mjs</code>. Tombol di kanan atas mengganti tema gelap, teks 200 % dan tablet untuk semua layar (usulan v2).</p>
  </header>

  <main class="doc">
    <nav class="index-toc" aria-label="Grup layar">
${groups.map((g) => `      <a href="#g-${g.dir}">${esc(g.title)} <span class="index-toc__count">${g.pages.length}</span></a>`).join('\n')}
      <a href="#cakupan">Cakupan layar Flutter</a>
    </nav>
${groups.map((g) => `
    <section class="doc-section" id="g-${g.dir}" aria-labelledby="h-${g.dir}">
      <h2 id="h-${g.dir}">${esc(g.title)}</h2>
      <p>Folder <code>${g.dir}/</code>, gaya grup <code>css/pages/${g.dir}.css</code>. Dart: <code>${esc(g.dart)}</code>. ${g.pages.length} halaman, ${g.pages.reduce((n, p) => n + p.frames, 0)} frame.</p>
      <div class="index-list">
${g.pages.map(card).join('\n')}
      </div>
    </section>`).join('\n')}

    <section class="doc-section" id="cakupan" aria-labelledby="h-cakupan">
      <h2 id="h-cakupan">Cakupan layar Flutter</h2>
      <p>Setiap <code>lib/**/*_screen.dart</code> dan <code>lib/app/app_shell.dart</code> beserta halaman mockupnya. <code>account/blocked_users_screen.dart</code> dan <code>account/my_reports_screen.dart</code> hanya mengekspor ulang layar di <code>network/</code>; keduanya dimockup di grup Akun dan Jejaring (lihat catatan di halamannya).</p>
      <div class="index-table-wrap">
        <table class="index-table">
          <thead><tr><th scope="col">Layar Flutter</th><th scope="col">Halaman mockup</th><th scope="col">Rute</th></tr></thead>
          <tbody>
${coverage.map(covRow).join('\n')}
          </tbody>
        </table>
      </div>
${extras.length ? `      <h3 class="index-subtitle">Halaman tambahan (bukan berkas <code>*_screen.dart</code>)</h3>
      <ul class="index-extras">
${extras.map((p) => `        <li><a href="${p.href}">${esc(p.title)}</a> <code>${p.href}</code>: ${ddHtml(p.dart)}</li>`).join('\n')}
      </ul>` : ''}
    </section>
  </main>
</body>
</html>
`;
writeFileSync(join(root, 'index.html'), out);
console.log(`index.html: ${pages.length} halaman, ${totalFrames} frame, cakupan ${coverage.length - missing.length}/${coverage.length}`);
for (const m of missing) console.warn(`BELUM ADA HALAMAN: ${m.s}`);
