// assets/js/loganalysis.js
// The uploaded log file is read and parsed entirely in the browser via
// FileReader — it never leaves the device, which is actually a nice
// side effect of not having a server to upload to.

(() => {
  const fileInput = document.getElementById('logFileInput');
  const fileNameLabel = document.getElementById('fileNameLabel');
  const uploadBtn = document.getElementById('uploadBtn');
  const uploadStatus = document.getElementById('uploadStatus');
  const resultSection = document.getElementById('resultSection');
  const sampleLogBtn = document.getElementById('sampleLogBtn');
  const exportCsvBtn = document.getElementById('exportCsvBtn');
  const compareFileInput = document.getElementById('compareFileInput');
  const compareFileLabel = document.getElementById('compareFileLabel');
  const comparisonResult = document.getElementById('comparisonResult');

  let hourlyChart = null;
  let protocolChart = null;
  let selectedFile = null;
  let currentSummary = null; // most recently analyzed result — reused by CSV export & comparison

  // Shared by both the main upload and the "compare" upload: validates,
  // reads, parses, and summarizes a file. Returns a Promise<summary>.
  function analyzeFile(file) {
    const allowedExt = ['txt', 'log', 'csv'];
    const ext = file.name.split('.').pop().toLowerCase();
    if (!allowedExt.includes(ext)) return Promise.reject('Format file harus .txt, .log, atau .csv');
    if (file.size > 10 * 1024 * 1024) return Promise.reject('Ukuran file maksimal 10 MB');

    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const records = parseLogText(String(reader.result));
        if (records.length === 0) {
          reject('File berhasil dibaca, tapi tidak ada baris yang berhasil dikenali. Pastikan formatnya sesuai contoh log Mikrotik atau CSV dengan kolom src_ip/dst_ip.');
          return;
        }
        const summary = summarizeLogRecords(records);
        summary.filename = file.name;
        summary.created_at = new Date().toLocaleString('id-ID');
        resolve(summary);
      };
      reader.onerror = () => reject('Gagal membaca file.');
      reader.readAsText(file);
    });
  }

  fileInput.addEventListener('change', () => {
    selectedFile = fileInput.files[0] || null;
    fileNameLabel.textContent = selectedFile ? selectedFile.name : 'Belum ada file dipilih.';
    uploadBtn.disabled = !selectedFile;
  });

  sampleLogBtn.addEventListener('click', () => downloadSampleLog());

  uploadBtn.addEventListener('click', async () => {
    if (!selectedFile) return;
    uploadBtn.disabled = true;
    uploadStatus.textContent = 'Membaca dan menganalisis file...';

    try {
      const summary = await analyzeFile(selectedFile);
      uploadStatus.textContent = `Berhasil menganalisis ${summary.total_records} baris dari "${selectedFile.name}".`;
      currentSummary = summary;
      renderResult(summary);
      renderHistory(Store.addLogAnalysis(summary));
      comparisonResult.classList.add('hidden'); // stale comparison from a previous file
    } catch (msg) {
      uploadStatus.textContent = typeof msg === 'string' ? msg : 'Gagal memproses file. Pastikan formatnya sesuai contoh.';
    } finally {
      uploadBtn.disabled = false;
    }
  });

  compareFileInput.addEventListener('change', async () => {
    const file = compareFileInput.files[0];
    if (!file || !currentSummary) return;
    compareFileLabel.textContent = `Menganalisis ${file.name}...`;

    try {
      const beforeSummary = await analyzeFile(file);
      compareFileLabel.textContent = file.name;
      renderComparison(beforeSummary, currentSummary);
    } catch (msg) {
      compareFileLabel.textContent = typeof msg === 'string' ? msg : 'Gagal memproses file pembanding.';
    }
  });

  exportCsvBtn.addEventListener('click', () => {
    if (!currentSummary) return;
    const rows = [['IP', 'Bytes', 'Jumlah Paket']];
    currentSummary.top_sources.forEach(s => rows.push([s.ip, s.bytes, s.count]));
    downloadCsv(rows, `netoptima-top-ip-${Date.now()}.csv`);
  });

  function downloadCsv(rows, filename) {
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  function formatHour(h) {
    return h === null || h === undefined ? '—' : String(h).padStart(2, '0') + ':00';
  }

  function formatBytes(bytes) {
    if (bytes >= 1_000_000) return (bytes / 1_000_000).toFixed(2) + ' MB';
    if (bytes >= 1_000) return (bytes / 1_000).toFixed(1) + ' KB';
    return bytes + ' B';
  }

  // Returns a colored ↑/↓ delta string; `lowerIsBetter` flips which
  // direction counts as an improvement (e.g. less traffic = good).
  function deltaLabel(before, after, lowerIsBetter = true) {
    if (!before) return `${after} <span class="text-muted text-xs">(baseline tidak ada)</span>`;
    const pct = ((after - before) / before) * 100;
    const improved = lowerIsBetter ? pct <= 0 : pct >= 0;
    const arrow = pct === 0 ? '→' : pct > 0 ? '↑' : '↓';
    const cls = pct === 0 ? 'text-muted' : improved ? 'text-signal' : 'text-alert';
    return `${after} <span class="${cls} font-mono text-xs">${arrow} ${Math.abs(pct).toFixed(1)}%</span>`;
  }

  function renderComparison(before, after) {
    comparisonResult.classList.remove('hidden');
    const beforeTop = before.top_sources[0]?.ip || '—';
    const afterTop = after.top_sources[0]?.ip || '—';
    const topChanged = beforeTop !== afterTop;

    comparisonResult.innerHTML = `
      <div class="grid sm:grid-cols-2 gap-4 mb-4">
        <div class="text-xs text-muted font-mono">SEBELUM: ${escapeHtml(before.filename)}</div>
        <div class="text-xs text-muted font-mono">SESUDAH: ${escapeHtml(after.filename)}</div>
      </div>
      <table class="data-table">
        <thead><tr><th>Metrik</th><th>Sebelum</th><th>Sesudah</th></tr></thead>
        <tbody>
          <tr><td>Total baris trafik</td><td>${before.total_records}</td><td>${deltaLabel(before.total_records, after.total_records)}</td></tr>
          <tr><td>IP paling dominan</td><td>${escapeHtml(beforeTop)}</td><td>${escapeHtml(afterTop)} ${topChanged ? '<span class="badge badge-warn">berubah</span>' : '<span class="badge badge-good">tetap</span>'}</td></tr>
          <tr><td>Jam tersibuk</td><td>${before.has_time_data ? formatHour(before.busiest_hour) : '—'}</td><td>${after.has_time_data ? formatHour(after.busiest_hour) : '—'}</td></tr>
        </tbody>
      </table>
      <p class="text-xs text-muted mt-3 leading-relaxed">
        Hijau = membaik, merah = memburuk.
      </p>
    `;
  }

  function renderResult(result) {
    resultSection.classList.remove('hidden');

    document.getElementById('totalRecords').textContent = result.total_records;
    document.getElementById('busiestHourLog').textContent = result.has_time_data ? formatHour(result.busiest_hour) : 'Tidak ada data waktu';
    document.getElementById('topIp').textContent = result.top_sources[0] ? result.top_sources[0].ip : '—';

    const tbody = document.getElementById('topSourcesBody');
    tbody.innerHTML = '';
    result.top_sources.forEach(s => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${escapeHtml(s.ip)}</td><td>${formatBytes(s.bytes)}</td><td>${s.count}</td>`;
      tbody.appendChild(tr);
    });

    const hourlyLabels = result.hourly_bytes.map((_, h) => formatHour(h));
    const hourlyCtx = document.getElementById('hourlyChart').getContext('2d');
    if (hourlyChart) hourlyChart.destroy();
    hourlyChart = new Chart(hourlyCtx, {
      type: 'bar',
      data: { labels: hourlyLabels, datasets: [{ label: 'Trafik per jam', data: result.hourly_bytes, backgroundColor: '#F87171' }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        scales: {
          x: { ticks: { color: '#8B96AF', maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }, grid: { color: '#1D2740' } },
          y: { ticks: { color: '#8B96AF' }, grid: { color: '#1D2740' }, beginAtZero: true },
        },
        plugins: { legend: { display: false } },
      },
    });

    const protoEntries = Object.entries(result.protocol_breakdown || {});
    const protoCtx = document.getElementById('protocolChart').getContext('2d');
    if (protocolChart) protocolChart.destroy();
    protocolChart = new Chart(protoCtx, {
      type: 'doughnut',
      data: {
        labels: protoEntries.map(e => e[0]),
        datasets: [{ data: protoEntries.map(e => e[1]), backgroundColor: ['#34D399', '#FBBF24', '#F87171', '#60A5FA', '#C084FC', '#8B96AF'], borderColor: '#161D2F' }],
      },
      options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { position: 'bottom', labels: { color: '#E7ECF5' } } } },
    });
  }

  function renderHistory(history) {
    const tbody = document.getElementById('logHistoryBody');
    tbody.innerHTML = '';
    history.slice().reverse().forEach(h => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${escapeHtml(h.filename)}</td><td>${escapeHtml(h.created_at)}</td>`;
      tbody.appendChild(tr);
    });
  }

  const history = Store.getLogHistory();
  renderHistory(history);
  if (history.length > 0) {
    currentSummary = history[history.length - 1];
    renderResult(currentSummary);
  }
})();
