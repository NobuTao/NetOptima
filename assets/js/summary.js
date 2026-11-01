// assets/js/summary.js
// Pure read-and-summarize: no new measurements happen here. Everything
// comes from what Modul 1–3 already saved to localStorage.

(() => {
  const sumDownload      = document.getElementById('sumDownload');
  const sumDownloadTrend = document.getElementById('sumDownloadTrend');
  const sumHealth        = document.getElementById('sumHealth');
  const sumHealthTrend   = document.getElementById('sumHealthTrend');
  const sumTopIp         = document.getElementById('sumTopIp');
  const sumTopIpShare    = document.getElementById('sumTopIpShare');
  const narrativeText    = document.getElementById('narrativeText');
  const printSummaryBtn  = document.getElementById('printSummaryBtn');
  const printSummary     = document.getElementById('printSummary');

  // Splits a list into an "earlier half" and "later half" so we can compare
  // averages and describe a trend, without needing explicit timestamps math.
  function splitTrend(list) {
    if (list.length < 2) return null;
    const mid = Math.floor(list.length / 2) || 1;
    return { earlier: list.slice(0, mid), later: list.slice(mid) };
  }

  function pctChange(before, after) {
    if (!before) return null;
    return ((after - before) / before) * 100;
  }

  function trendPhrase(pct, goodDirection = 'up') {
    if (pct === null) return { text: 'data belum cukup untuk melihat tren', cls: 'text-muted' };
    const rounded = Math.abs(pct).toFixed(1);
    const isUp = pct > 0;
    const isGood = goodDirection === 'up' ? isUp : !isUp;
    const arrow = pct === 0 ? '→ stabil' : isUp ? `↑ naik ${rounded}%` : `↓ turun ${rounded}%`;
    return { text: arrow, cls: pct === 0 ? 'text-muted' : isGood ? 'text-signal' : 'text-alert' };
  }

  // ─── Speed Test summary ─────────────────────────────────────────────────
  const speedHistory = Store.getSpeedtestHistory();
  let downloadNarrative = 'Belum ada data speed test.';
  if (speedHistory.length > 0) {
    const avgAll = speedHistory.reduce((s, r) => s + r.download_mbps, 0) / speedHistory.length;
    sumDownload.innerHTML = `${avgAll.toFixed(1)} <span class="text-sm text-muted">Mbps (rata-rata)</span>`;

    const split = splitTrend(speedHistory.map(r => r.download_mbps));
    if (split) {
      const avgEarlier = split.earlier.reduce((a, b) => a + b, 0) / split.earlier.length;
      const avgLater = split.later.reduce((a, b) => a + b, 0) / split.later.length;
      const { text, cls } = trendPhrase(pctChange(avgEarlier, avgLater), 'up');
      sumDownloadTrend.innerHTML = `<span class="${cls}">${text}</span> dari ${speedHistory.length} tes`;
      downloadNarrative = `Kecepatan download rata-rata ${avgAll.toFixed(1)} Mbps dari ${speedHistory.length} kali pengujian (${text.replace(/<[^>]+>/g, '')}).`;
    } else {
      sumDownloadTrend.textContent = `Dari 1 tes`;
      downloadNarrative = `Baru ada 1 hasil speed test: ${avgAll.toFixed(1)} Mbps. Jalankan beberapa kali lagi untuk melihat tren.`;
    }
  }

  // ─── Health score summary ───────────────────────────────────────────────
  const healthHistory = Store.getHealthHistory();
  let healthNarrative = 'Belum ada data monitoring jaringan.';
  if (healthHistory.length > 0) {
    const latest = healthHistory[healthHistory.length - 1];
    sumHealth.textContent = latest.score;
    sumHealth.className = 'stat-value text-2xl font-semibold ' + (latest.score >= 75 ? 'text-signal' : latest.score >= 55 ? 'text-upload' : 'text-alert');

    const split = splitTrend(healthHistory.map(h => h.score));
    if (split) {
      const avgEarlier = split.earlier.reduce((a, b) => a + b, 0) / split.earlier.length;
      const avgLater = split.later.reduce((a, b) => a + b, 0) / split.later.length;
      const { text, cls } = trendPhrase(pctChange(avgEarlier, avgLater), 'up');
      sumHealthTrend.innerHTML = `<span class="${cls}">${text}</span> selama sesi`;
      healthNarrative = `Skor kesehatan jaringan saat ini ${latest.score}/100 (${text.replace(/<[^>]+>/g, '')} dibanding awal sesi monitoring).`;
    } else {
      sumHealthTrend.textContent = 'Skor sesi berjalan';
      healthNarrative = `Skor kesehatan jaringan saat ini ${latest.score}/100.`;
    }
  }

  // ─── Log analysis summary ───────────────────────────────────────────────
  const logHistory = Store.getLogHistory();
  let logNarrative = 'Belum ada file log yang dianalisis.';
  if (logHistory.length > 0) {
    const latest = logHistory[logHistory.length - 1];
    const top = latest.top_sources[0];
    if (top) {
      const totalTop10Bytes = latest.top_sources.reduce((s, x) => s + x.bytes, 0);
      const share = totalTop10Bytes > 0 ? (top.bytes / totalTop10Bytes) * 100 : null;
      sumTopIp.textContent = top.ip;
      sumTopIpShare.textContent = share !== null
        ? `${share.toFixed(0)}% dari trafik 10 IP teratas`
        : `dari ${latest.filename}`;
      logNarrative = share !== null
        ? `Analisis log terbaru (${latest.filename}) menunjukkan IP ${top.ip} paling dominan, menyumbang sekitar ${share.toFixed(0)}% dari trafik 10 IP teratas.`
        : `Analisis log terbaru (${latest.filename}) menunjukkan IP ${top.ip} sebagai yang paling banyak trafik.`;
    }
  }

  // ─── Combined narrative ──────────────────────────────────────────────────
  const hasAnyData = speedHistory.length > 0 || healthHistory.length > 0 || logHistory.length > 0;
  if (hasAnyData) {
    narrativeText.innerHTML = [downloadNarrative, healthNarrative, logNarrative]
      .map(t => `<p class="mb-2">• ${t}</p>`).join('');
  }

  // ─── Print / PDF export ──────────────────────────────────────────────────
  printSummaryBtn.addEventListener('click', () => {
    printSummary.innerHTML = `
      <h1>Ringkasan Eksekutif Jaringan — NetOptima</h1>
      <p class="print-meta">Dibuat: ${new Date().toLocaleString('id-ID')}</p>
      <h2>Ringkasan</h2>
      <table>
        <tr><th>Rata-rata Download</th><td>${sumDownload.textContent}</td></tr>
        <tr><th>Skor Kesehatan Jaringan</th><td>${sumHealth.textContent}</td></tr>
        <tr><th>IP Paling Dominan (log terbaru)</th><td>${sumTopIp.textContent}</td></tr>
      </table>
      <h2>Kesimpulan</h2>
      ${narrativeText.innerHTML}
      <p class="print-meta">Laporan ini dirangkum otomatis dari data yang tersimpan di modul Speed Test, Monitoring Jaringan, dan Analisis Log pada browser ini.</p>
    `;
    window.print();
  });

  // ─── Export / Import all data ─────────────────────────────────────────
  document.getElementById('exportAllBtn').addEventListener('click', () => {
    Store.exportAll();
  });

  const importInput = document.getElementById('importAllInput');
  const importStatus = document.getElementById('importStatus');

  importInput.addEventListener('change', () => {
    const file = importInput.files[0];
    if (!file) return;

    importStatus.textContent = 'Membaca file...';
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const payload = JSON.parse(String(reader.result));
        const counts = Store.importAll(payload);
        importStatus.textContent = `Berhasil impor: ${counts.speedtest} speed test, ${counts.log} analisis log, ${counts.health} snapshot kesehatan. Muat ulang halaman untuk melihat pembaruan.`;
      } catch (err) {
        importStatus.textContent = err.message || 'Gagal membaca file backup. Pastikan ini file JSON hasil ekspor NetOptima.';
      } finally {
        importInput.value = '';
      }
    };
    reader.onerror = () => { importStatus.textContent = 'Gagal membaca file.'; };
    reader.readAsText(file);
  });
})();
