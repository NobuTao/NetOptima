// assets/js/speedtest.js
// Ping/jitter and download are measured for real, against files served by
// this same static site. True upload-speed measurement needs a server to
// receive and time the transfer — GitHub Pages doesn't have one, so this
// tries a public CORS-enabled echo endpoint as a best-effort fallback and
// is upfront in the UI when that isn't available.

(() => {
  const startBtn = document.getElementById('startTestBtn');
  const statusText = document.getElementById('statusText');
  const progressFill = document.getElementById('progressFill');
  const statDownload = document.getElementById('statDownload');
  const statUpload = document.getElementById('statUpload');
  const statPing = document.getElementById('statPing');
  const statJitter = document.getElementById('statJitter');
  const interpretationBox = document.getElementById('interpretation');
  const uploadNote = document.getElementById('uploadNote');

  const DOWNLOAD_PROBE_URL  = 'assets/testfile-probe.bin';  // 256 KB — quick first read
  const DOWNLOAD_MEDIUM_URL = 'assets/testfile-medium.bin'; // 2 MB   — typical home/mobile connections
  const DOWNLOAD_LARGE_URL  = 'assets/testfile-large.bin';  // 8 MB   — fast campus/office connections
  const PING_URL = 'assets/ping.txt';
  const UPLOAD_ECHO_URL = 'https://httpbin.org/post';

  const UPLOAD_SIZE_BYTES = 1 * 1024 * 1024; // 1 MB — kept small for reliability on a public echo endpoint
  const PING_SAMPLES = 6;
  const UPLOAD_TIMEOUT_MS = 8000;

  function setProgress(pct) {
    progressFill.style.width = Math.max(0, Math.min(100, pct)) + '%';
  }

  function setStatus(text) {
    statusText.textContent = text;
  }

  async function measurePing() {
    const samples = [];
    for (let i = 0; i < PING_SAMPLES; i++) {
      const start = performance.now();
      await fetch(`${PING_URL}?_=${Date.now()}-${i}`, { cache: 'no-store' });
      samples.push(performance.now() - start);
      setProgress((i + 1) / PING_SAMPLES * 20);
    }
    const ping = samples.reduce((a, b) => a + b, 0) / samples.length;

    let jitterSum = 0;
    for (let i = 1; i < samples.length; i++) {
      jitterSum += Math.abs(samples[i] - samples[i - 1]);
    }
    const jitter = samples.length > 1 ? jitterSum / (samples.length - 1) : 0;

    return { ping, jitter };
  }

  async function fetchAndTime(url) {
    const start = performance.now();
    const res = await fetch(`${url}?_=${Date.now()}`, { cache: 'no-store' });
    const buf = await res.arrayBuffer();
    const seconds = (performance.now() - start) / 1000;
    const mbps = (buf.byteLength * 8 / seconds) / 1_000_000;
    return { mbps, seconds };
  }

  // Adaptive download test: a fixed small file badly under-measures fast
  // connections (dominated by TCP/TLS handshake overhead) while a fixed
  // large file wastes time/data on slow ones. So this probes with a small
  // file first, then only downloads a bigger file if the probe suggests
  // it's worth it — similar to how Cloudflare/Fast.com scale their tests.
  async function measureDownload(onStageChange) {
    onStageChange?.('probe');
    const probe = await fetchAndTime(DOWNLOAD_PROBE_URL);
    setProgress(40);

    if (probe.mbps < 8) {
      // Slow connection: the probe itself is already a stable-enough read,
      // and downloading more would just cost the person time/data.
      setProgress(60);
      return probe.mbps;
    }

    onStageChange?.(probe.mbps >= 40 ? 'large' : 'medium');
    const second = await fetchAndTime(probe.mbps >= 40 ? DOWNLOAD_LARGE_URL : DOWNLOAD_MEDIUM_URL);
    setProgress(60);
    return second.mbps;
  }

  // Best-effort only: relies on a public third-party endpoint being
  // reachable and CORS-enabled. Returns null (not 0) when it can't
  // complete, so the caller can tell "measured as slow" apart from
  // "couldn't measure at all".
  async function measureUpload() {
    const payload = new Uint8Array(UPLOAD_SIZE_BYTES);
    const seedLen = Math.min(65536, UPLOAD_SIZE_BYTES);
    crypto.getRandomValues(payload.subarray(0, seedLen));
    for (let offset = seedLen; offset < UPLOAD_SIZE_BYTES; offset += seedLen) {
      payload.set(payload.subarray(0, Math.min(seedLen, UPLOAD_SIZE_BYTES - offset)), offset);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

    try {
      const start = performance.now();
      await fetch(UPLOAD_ECHO_URL, {
        method: 'POST',
        body: payload,
        cache: 'no-store',
        signal: controller.signal,
      });
      const seconds = (performance.now() - start) / 1000;
      const bits = payload.byteLength * 8;
      return (bits / seconds) / 1_000_000;
    } catch (err) {
      console.warn('Upload test tidak tersedia (endpoint publik tidak dapat diakses):', err);
      return null;
    } finally {
      clearTimeout(timeout);
      setProgress(90);
    }
  }

  function interpret({ download, upload, ping, jitter }) {
    const lines = [];

    if (download >= 25) {
      lines.push('Kecepatan unduh kamu tergolong tinggi — cukup untuk streaming 4K, download besar, dan multi-device sekaligus.');
    } else if (download >= 10) {
      lines.push('Kecepatan unduh kamu cukup untuk streaming HD dan video call lancar, tapi mungkin terasa berat kalau dipakai banyak perangkat bersamaan.');
    } else if (download >= 4) {
      lines.push('Kecepatan unduh kamu pas-pasan untuk browsing dan video call kualitas rendah-menengah; streaming HD atau download besar akan terasa lambat.');
    } else {
      lines.push('Kecepatan unduh kamu tergolong rendah — aktivitas seperti streaming HD atau video call kemungkinan akan sering buffering.');
    }

    if (ping <= 30) {
      lines.push('Latency rendah, cocok untuk gaming online dan video call real-time.');
    } else if (ping <= 80) {
      lines.push('Latency masih wajar untuk kebutuhan sehari-hari, tapi kurang ideal untuk gaming kompetitif.');
    } else {
      lines.push('Latency cukup tinggi — bisa terasa delay saat video call atau bermain game online.');
    }

    if (jitter > 15) {
      lines.push('Jitter (kestabilan koneksi) tergolong tinggi, artinya koneksi kamu naik-turun — video call atau VoIP berpotensi terputus-putus.');
    } else {
      lines.push('Jitter tergolong stabil, koneksi tidak banyak berfluktuasi.');
    }

    if (upload !== null && upload < download / 4) {
      lines.push('Kecepatan unggah jauh lebih kecil dari unduh — wajar untuk koneksi rumahan, tapi perlu diperhatikan kalau kamu sering upload file besar atau live streaming.');
    }

    return lines.map(l => `<p class="mb-2">• ${l}</p>`).join('');
  }

  let historyChart = null;

  function renderHistory(results) {
    const tbody = document.getElementById('historyTableBody');
    const emptyLabel = document.getElementById('historyEmpty');
    tbody.innerHTML = '';

    emptyLabel.classList.toggle('hidden', results.length > 0);

    results.slice().reverse().forEach(r => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(r.created_at)}</td>
        <td>${Number(r.download_mbps).toFixed(1)} Mbps</td>
        <td>${r.upload_mbps === null ? '—' : Number(r.upload_mbps).toFixed(1) + ' Mbps'}</td>
        <td>${Number(r.ping_ms).toFixed(0)} ms</td>
        <td>${Number(r.jitter_ms).toFixed(1)} ms</td>
      `;
      tbody.appendChild(tr);
    });

    const labels = results.map(r => String(r.created_at).slice(5, 16));
    const downloadSeries = results.map(r => Number(r.download_mbps));
    const uploadSeries = results.map(r => r.upload_mbps === null ? null : Number(r.upload_mbps));

    const ctx = document.getElementById('historyChart').getContext('2d');
    if (historyChart) {
      historyChart.data.labels = labels;
      historyChart.data.datasets[0].data = downloadSeries;
      historyChart.data.datasets[1].data = uploadSeries;
      historyChart.update();
      return;
    }

    historyChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Download (Mbps)', data: downloadSeries, borderColor: '#34D399', backgroundColor: 'rgba(52,211,153,0.1)', tension: 0.3, fill: true, spanGaps: true },
          { label: 'Upload (Mbps)', data: uploadSeries, borderColor: '#FBBF24', backgroundColor: 'rgba(251,191,36,0.08)', tension: 0.3, fill: true, spanGaps: true },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { ticks: { color: '#8B96AF', maxRotation: 0 }, grid: { color: '#1D2740' } },
          y: { ticks: { color: '#8B96AF' }, grid: { color: '#1D2740' }, beginAtZero: true },
        },
        plugins: { legend: { labels: { color: '#E7ECF5' } } },
      },
    });
  }

  function loadHistory() {
    renderHistory(Store.getSpeedtestHistory());
  }

  async function runTest() {
    startBtn.disabled = true;
    interpretationBox.classList.add('hidden');
    uploadNote.classList.add('hidden');
    statDownload.textContent = '—';
    statUpload.textContent = '—';
    statPing.textContent = '—';
    statJitter.textContent = '—';
    setProgress(0);

    try {
      setStatus('Mengukur latency & jitter...');
      const { ping, jitter } = await measurePing();
      statPing.textContent = ping.toFixed(0);
      statJitter.textContent = jitter.toFixed(1);

      setStatus('Mengukur kecepatan unduh (tahap awal)...');
      const download = await measureDownload((stage) => {
        if (stage === 'medium') setStatus('Koneksi cukup cepat — mengukur dengan file lebih besar...');
        if (stage === 'large') setStatus('Koneksi cepat terdeteksi — mengukur dengan file besar untuk akurasi...');
      });
      statDownload.textContent = download.toFixed(1);

      setStatus('Mencoba mengukur kecepatan unggah...');
      const upload = await measureUpload();
      statUpload.textContent = upload === null ? 'N/A' : upload.toFixed(1);
      if (upload === null) {
        uploadNote.classList.remove('hidden');
      }

      setStatus('Menyimpan hasil...');
      Store.addSpeedtestResult({
        download_mbps: download,
        upload_mbps: upload,
        ping_ms: ping,
        jitter_ms: jitter,
        created_at: new Date().toLocaleString('id-ID'),
      });

      setProgress(100);
      setStatus('Selesai.');

      interpretationBox.innerHTML = interpret({ download, upload, ping, jitter });
      interpretationBox.classList.remove('hidden');

      loadHistory();
    } catch (err) {
      console.error(err);
      setStatus('Terjadi kesalahan saat pengujian. Coba lagi.');
    } finally {
      startBtn.disabled = false;
    }
  }

  document.getElementById('exportHistoryCsvBtn').addEventListener('click', () => {
    const rows = [['Waktu', 'Download (Mbps)', 'Upload (Mbps)', 'Ping (ms)', 'Jitter (ms)']];
    Store.getSpeedtestHistory().forEach(r =>
      rows.push([r.created_at, r.download_mbps.toFixed(1), r.upload_mbps === null ? 'N/A' : r.upload_mbps.toFixed(1), r.ping_ms.toFixed(0), r.jitter_ms.toFixed(1)])
    );
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `netoptima-speedtest-${Date.now()}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  });

  startBtn.addEventListener('click', runTest);
  loadHistory();
})();
