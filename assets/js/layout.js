// assets/js/layout.js
// Injects the header/nav/footer that used to be copy-pasted into every
// page (index/speedtest/simulation/loganalysis) into two placeholder
// elements: #site-header and #site-footer. This runs synchronously right
// where its <script> tag sits in the body (no fetch, no DOMContentLoaded
// wait), so there's no flash of missing nav and it still works when a
// page is opened directly via file:// without a local server.

(() => {
  const NAV_ITEMS = [
    { href: 'index.html', label: 'Beranda', key: 'home' },
    { href: 'speedtest.html', label: 'Speed Test', key: 'speedtest' },
    { href: 'simulation.html', label: 'Monitoring Jaringan', key: 'simulation' },
    { href: 'loganalysis.html', label: 'Analisis Log', key: 'log' },
    { href: 'summary.html', label: 'Ringkasan', key: 'summary' },
    { href: 'capacity.html', label: 'Kapasitas', key: 'capacity' },
  ];

  function navLinks(active) {
    return NAV_ITEMS.map(item =>
      `<a href="${item.href}" class="nav-link ${item.key === active ? 'nav-link-active' : ''}">${item.label}</a>`
    ).join('');
  }

  function renderHeader(active) {
    const el = document.getElementById('site-header');
    if (!el) return;
    el.outerHTML = `
<header class="border-b border-border bg-surface sticky top-0 z-30">
  <div class="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
    <a href="index.html" class="flex items-center gap-3 group">
      <span class="signal-mark" aria-hidden="true"><span></span><span></span><span></span><span></span></span>
      <span class="font-display font-semibold text-lg tracking-tight">NetOptima</span>
    </a>
    <nav class="hidden sm:flex items-center gap-1 text-sm">${navLinks(active)}</nav>
    <button id="mobileMenuBtn" class="sm:hidden text-fog p-2" aria-label="Buka menu">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
    </button>
  </div>
  <nav id="mobileMenu" class="sm:hidden hidden border-t border-border px-4 py-3 flex flex-col gap-1 text-sm">${navLinks(active)}</nav>
</header>`;
  }

  function renderFooter() {
    const el = document.getElementById('site-footer');
    if (!el) return;
    el.outerHTML = `
<footer class="border-t border-border mt-auto">
  <div class="max-w-6xl mx-auto px-4 sm:px-6 py-6 text-xs text-muted flex flex-col sm:flex-row gap-2 sm:justify-between">
    <span>NetOptima — Sistem Analisis, Monitoring &amp; Optimalisasi Bandwidth Jaringan</span>
    <span>Versi Statis &middot; HTML/CSS/JS &middot; GitHub Pages</span>
  </div>
</footer>`;
  }

  function wireMobileMenu() {
    const btn = document.getElementById('mobileMenuBtn');
    const menu = document.getElementById('mobileMenu');
    if (btn && menu) {
      btn.addEventListener('click', () => menu.classList.toggle('hidden'));
    }
  }

  // document.currentScript exposes the <script data-active="..."> tag that
  // loaded this file, so each page just declares which nav item is active.
  const active = document.currentScript?.dataset?.active || '';
  renderHeader(active);
  wireMobileMenu();

  // The header placeholder sits early in <body> so this script can render
  // it immediately (no flash of missing nav). The footer placeholder sits
  // near the end of <body>, which hasn't been parsed yet at this point —
  // so its render is deferred until the DOM is fully parsed.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderFooter);
  } else {
    renderFooter();
  }
})();
