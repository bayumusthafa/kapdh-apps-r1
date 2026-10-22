// Handler Paged.js: kepala tabel (thead) diulang di halaman lanjutan saat tabel terbelah, dan pemecahan halaman
// tidak pernah jatuh di dalam thead (kepala tabel tidak tertinggal sendirian di dasar halaman).
(function () {
  class RepeatTableHeaders extends Paged.Handler {
    constructor(chunker, polisher, caller) {
      super(chunker, polisher, caller);
      this.splitRefs = [];
    }

    afterPageLayout(pageElement, page, breakToken, chunker) {
      this.chunker = chunker;
      this.splitRefs = [];
      if (!breakToken) return;
      const node = breakToken.node;
      const tables = ancestors(node, 'table');
      if (node.tagName === 'TABLE') tables.push(node);
      if (!tables.length) return;
      this.splitRefs = tables.map(t => t.dataset.ref);
      const thead = node.tagName === 'THEAD' ? node : firstAncestor(node, 'thead');
      if (thead) breakToken.node = nodeAfter(thead.hasChildNodes() ? thead.lastChild : thead, chunker.source);
      // tabel yang di halaman ini belum berisi satu baris pun dipindah utuh ke halaman berikut, bersama judul tabel
      // dan judul subbab (.mv) bila ada, agar tidak tertinggal sendirian di dasar halaman
      for (const ref of this.splitRefs) {
        const t = pageElement.querySelector(`[data-ref='${ref}']`);
        if (!t || t.querySelector('tbody > tr')) continue;
        const wrap = t.closest('.mv') || t.closest('.tbl');
        const src = wrap && chunker.source.querySelector(`[data-ref='${wrap.dataset.ref}']`);
        if (src) { wrap.style.display = 'none'; breakToken.node = src; breakToken.offset = 0; this.splitRefs = []; }
        else { t.style.visibility = 'hidden'; t.style.position = 'absolute'; }
        break;
      }
    }

    layout(rendered) {
      for (const ref of this.splitRefs) {
        const t = rendered.querySelector(`[data-ref='${ref}']`);
        if (!t || t.getAttribute('data-repeated-header')) continue;
        const src = this.chunker.source.querySelector(`[data-ref='${ref}']`);
        const thead = src && src.querySelector('thead');
        if (thead) t.insertBefore(thead.cloneNode(true), t.firstChild);
        const cg = src && src.querySelector('colgroup');
        if (cg && !t.querySelector('colgroup')) t.insertBefore(cg.cloneNode(true), t.firstChild);
        t.setAttribute('data-repeated-header', 'true');
      }
    }
  }

  function firstAncestor(el, sel) {
    while (el.parentNode && el.parentNode.nodeType === 1) { if (el.parentNode.matches(sel)) return el.parentNode; el = el.parentNode; }
    return null;
  }
  function ancestors(el, sel) {
    const out = [];
    while (el && el.parentNode && el.parentNode.nodeType === 1) { if (el.parentNode.matches(sel)) out.unshift(el.parentNode); el = el.parentNode; }
    return out;
  }
  function ignorable(n) { return n.nodeType === 8 || (n.nodeType === 3 && /^[\t\n\r ]*$/.test(n.textContent)); }
  function nextSignificant(n) { while ((n = n.nextSibling)) if (!ignorable(n)) return n; return null; }
  function nodeAfter(node, limiter) {
    if (limiter && node === limiter) return undefined;
    let s = nextSignificant(node);
    if (s) return s;
    while ((node = node.parentNode)) {
      if (limiter && node === limiter) return undefined;
      s = nextSignificant(node);
      if (s) return s;
    }
    return undefined;
  }

  Paged.registerHandlers(RepeatTableHeaders);
})();
