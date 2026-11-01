// assets/js/simulation.js
// Network Monitoring — Real measurement engine.
//
// Everything measured here uses fetch + performance.now() against the
// selected server, so all numbers on this page reflect this device only:
//   - Ping / Latency   → HTTP round-trip time
//   - Jitter           → Standard deviation of the ping batch
//   - Packet Loss      → % of requests that time out / fail
//   - Download speed   → testfile-medium.bin download throughput (every ~60 s)
//   - Connection info  → navigator.connection API (type, effectiveType, RTT)
//
(() => {
  // ─── Config ───────────────────────────────────────────────────────────────
  const PING_TARGETS = [
    { id: 'cloudflare', name: 'Cloudflare',    url: 'https://1.1.1.1/cdn-cgi/trace',                region: 'SG / Global' },
    { id: 'google',     name: 'Google',        url: 'https://www.google.com/favicon.ico',            region: 'Global'      },
    { id: 'dns',        name: 'DNS Google',    url: 'https://dns.google/resolve?name=a.com&type=A', region: 'Global'      },
    { id: 'local',      name: 'Server Lokal',  url: 'assets/ping.txt',                              region: 'CDN / Lokal' },
  ];

  const PING_TIMEOUT_MS   = 3000;  // treat a ping as lost after 3 s
  const PING_SAMPLES      = 5;     // parallel probes per tick
  const TICK_MS           = 5000;  // monitoring interval
  const BW_TICK_INTERVAL  = 12;    // download test every 12 ticks ≈ 60 s
  const DOWNLOAD_URL      = 'assets/testfile-medium.bin';
  const CHART_WINDOW      = 60;    // data points in rolling chart
  const MAX_ALERTS        = 60;

  // ─── State ────────────────────────────────────────────────────────────────
  let running      = true;
  let measuring    = false;
  let bwMeasuring  = false;
  let targetIdx    = 0;
  let tickCount    = 0;
  let uptimeSec    = 0;
  let alertCount   = 0;
  let intervalId   = null;
  let uptimeId     = null;
  let chart        = null;
  let lastBw       = null;       // last measured download Mbps
  let bwSource     = 'none';     // 'measured' | 'estimated' | 'none'
  let lastRealPing = null;       // last valid measured ping (ms)
  let prevPing     = null;       // for alert change detection
  let prevLoss     = 0;

  const pingHistory = Array(CHART_WINDOW).fill(null);
  const lossHistory = Array(CHART_WINDOW).fill(null);
  const timeLabels  = Array(CHART_WINDOW).fill('');

  // ─── DOM refs ─────────────────────────────────────────────────────────────
  const toggleBtn       = document.getElementById('toggleBtn');
  const toggleLabel     = document.getElementById('toggleLabel');
  const toggleIcon      = document.getElementById('toggleIcon');
  const resetBtn        = document.getElementById('resetBtn');
  const serverTabsEl    = document.getElementById('serverTabs');
  const liveIndicator   = document.getElementById('liveIndicator');
  const liveLabel       = document.getElementById('liveLabel');
  const uptimeDisplay   = document.getElementById('uptimeDisplay');
  const statusBanner    = document.getElementById('statusBanner');
  const statusDot       = document.getElementById('statusDot');
  const statusTitle     = document.getElementById('statusTitle');
  const statusDesc      = document.getElementById('statusDesc');
  const scoreRing       = document.getElementById('scoreRing');
  const scoreValue      = document.getElementById('scoreValue');
  const reportBtn       = document.getElementById('reportBtn');
  const printReport     = document.getElementById('printReport');
  const measuringStatus = document.getElementById('measuringStatus');
  const metricPing      = document.getElementById('metricPing');
  const metricLoss      = document.getElementById('metricLoss');
  const metricJitter    = document.getElementById('metricJitter');
  const metricBw        = document.getElementById('metricBw');
  const bwNote          = document.getElementById('bwNote');
  const cardPing        = document.getElementById('cardPing');
  const cardLoss        = document.getElementById('cardLoss');
  const cardJitter      = document.getElementById('cardJitter');
  const alertLog        = document.getElementById('alertLog');
  const alertCountEl    = document.getElementById('alertCount');
  const deviceTableBody = document.getElementById('deviceTableBody');
  const connTypeEl      = document.getElementById('connType');
  const connEffectiveEl = document.getElementById('connEffective');
  const connRttEl       = document.getElementById('connRtt');
  const connSaveDataEl  = document.getElementById('connSaveData');
  const connUnavailNote = document.getElementById('connUnavailNote');

  // ─── Measurement: Ping ────────────────────────────────────────────────────
  // Uses fetch + performance.now() as a proxy for ICMP ping.
  // mode:'no-cors' for external URLs → opaque response but timing still works.
  async function measureOnePing(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
    const sep = url.includes('?') ? '&' : '?';
    const bustedUrl = `${url}${sep}_=${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const isExternal = url.startsWith('http');
    const start = performance.now();
    try {
      await fetch(bustedUrl, {
        mode: isExternal ? 'no-cors' : 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
      });
      clearTimeout(timer);
      return performance.now() - start;
    } catch (_) {
      clearTimeout(timer);
      return null; // null = timed out or network error → packet lost
    }
  }

  // Run all pings in parallel so the batch completes in ~max(one_ping) time.
  async function runPingBatch() {
    const target = PING_TARGETS[targetIdx];
    return Promise.all(
      Array.from({ length: PING_SAMPLES }, () => measureOnePing(target.url))
    );
  }

  function calcAvgPing(samples) {
    const valid = samples.filter(v => v !== null);
    return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
  }

  // Jitter = standard deviation of the RTT samples.
  function calcJitter(samples) {
    const valid = samples.filter(v => v !== null);
    if (valid.length < 2) return 0;
    const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
    const variance = valid.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / valid.length;
    return Math.sqrt(variance);
  }

  function calcLoss(samples) {
    return (samples.filter(v => v === null).length / samples.length) * 100;
  }

  // ─── Measurement: Download speed ─────────────────────────────────────────
  async function measureDownload() {
    const start = performance.now();
    const res = await fetch(`${DOWNLOAD_URL}?_=${Date.now()}`, { cache: 'no-store' });
    const buf = await res.arrayBuffer();
    const seconds = (performance.now() - start) / 1000;
    return (buf.byteLength * 8) / seconds / 1_000_000; // Mbps
  }

  // Runs asynchronously, does not block the main tick.
  async function runBandwidthMeasure() {
    if (bwMeasuring) return;
    bwMeasuring = true;
    metricBw.style.opacity = '0.5';
    bwNote.textContent = 'Mbps — mengunduh…';
    try {
      const bw = await measureDownload();
      lastBw = bw;
      bwSource = 'measured';
      metricBw.textContent = fmt(bw);
      metricBw.style.color = '#34D399';
      bwNote.textContent = 'Mbps ✓ terukur';
      pushAlert('info', `Kecepatan download: ${fmt(bw)} Mbps (diukur dari ${DOWNLOAD_URL})`);
    } catch (e) {
      bwNote.textContent = lastBw !== null ? 'Mbps (terakhir diketahui)' : 'Mbps (gagal)';
      if (lastBw !== null) metricBw.textContent = fmt(lastBw);
      console.warn('Download measurement failed:', e);
    } finally {
      metricBw.style.opacity = '1';
      bwMeasuring = false;
    }
  }

  // ─── navigator.connection ────────────────────────────────────────────────
  function getNavConnection() {
    return navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
  }

  function updateConnectionPanel() {
    const conn = getNavConnection();
    if (!conn) {
      connUnavailNote.classList.remove('hidden');
      [connTypeEl, connEffectiveEl, connRttEl, connSaveDataEl].forEach(el => { el.textContent = '—'; });
      return;
    }

    const typeLabels = {
      wifi: '📶 Wi-Fi', cellular: '📡 Seluler', ethernet: '🔌 Ethernet',
      bluetooth: '🔵 Bluetooth', wimax: 'WiMAX', none: '❌ Tidak ada',
      other: 'Lainnya', unknown: 'Tidak diketahui',
    };
    const effectiveLabels = {
      '4g': '4G / LTE', '3g': '3G', '2g': '2G', 'slow-2g': 'Slow 2G',
    };

    connTypeEl.textContent      = typeLabels[conn.type] || (conn.type ? conn.type : '—');
    connEffectiveEl.textContent = effectiveLabels[conn.effectiveType] || (conn.effectiveType || '—');
    connRttEl.textContent       = conn.rtt != null ? conn.rtt : '—';
    connSaveDataEl.textContent  = conn.saveData ? '🟡 Aktif' : '🟢 Nonaktif';

    // Seed bandwidth display from browser estimate until real measurement runs
    if (lastBw === null && typeof conn.downlink === 'number' && conn.downlink > 0) {
      lastBw = conn.downlink;
      bwSource = 'estimated';
      metricBw.textContent = `~${fmt(conn.downlink)}`;
      bwNote.textContent = 'Mbps (estimasi browser)';
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function fmt(v, dec = 1) { return Number(v).toFixed(dec); }

  function nowLabel() {
    return new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function fmtUptime(sec) {
    const h = String(Math.floor(sec / 3600)).padStart(2, '0');
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
  }

  function getThisDeviceInfo() {
    const ua = navigator.userAgent;
    let name = 'Perangkat Ini', icon = '🖥️', browser = 'Browser';

    if (/Android/.test(ua))          { name = 'Android (Perangkat Ini)'; icon = '📱'; }
    else if (/iPhone|iPad/.test(ua)) { name = 'iOS (Perangkat Ini)';     icon = '📱'; }
    else if (/Windows/.test(ua))     { name = 'Windows (Perangkat Ini)'; icon = '💻'; }
    else if (/Mac/.test(ua))         { name = 'macOS (Perangkat Ini)';   icon = '💻'; }
    else if (/Linux/.test(ua))       { name = 'Linux (Perangkat Ini)';   icon = '🖥️'; }

    if (/Edg\//.test(ua))                             browser = 'Microsoft Edge';
    else if (/OPR\/|Opera/.test(ua))                  browser = 'Opera';
    else if (/Chrome\//.test(ua))                     browser = 'Google Chrome';
    else if (/Firefox\//.test(ua))                    browser = 'Firefox';
    else if (/Safari\//.test(ua) && !/Chrome/.test(ua)) browser = 'Safari';

    return { name, icon, browser };
  }

  // ─── Alert System ─────────────────────────────────────────────────────────
  function pushAlert(severity, message) {
    const placeholder = alertLog.querySelector('.italic');
    if (placeholder) placeholder.remove();

    alertCount++;
    alertCountEl.textContent = `${alertCount} event`;
    alertCountEl.className = severity === 'crit' ? 'badge badge-bad'
                           : severity === 'warn' ? 'badge badge-warn'
                           : 'badge badge-good';

    const badgeCls = severity === 'crit' ? 'alert-badge-crit'
                   : severity === 'warn' ? 'alert-badge-warn'
                   : 'alert-badge-info';

    const item = document.createElement('div');
    item.className = 'alert-item';
    item.innerHTML = `
      <span class="alert-badge ${badgeCls}">${severity.toUpperCase()}</span>
      <div class="flex-1 min-w-0">
        <p class="text-fog leading-snug">${escapeHtml(message)}</p>
        <p class="text-muted text-xs mt-0.5 font-mono">${nowLabel()}</p>
      </div>
    `;
    alertLog.insertBefore(item, alertLog.firstChild);
    while (alertLog.children.length > MAX_ALERTS) alertLog.removeChild(alertLog.lastChild);
  }

  // ─── Health Score ─────────────────────────────────────────────────────────
  // A single 0–100 diagnostic combining the four measured metrics, so the
  // dashboard gives a fast "is my network okay?" answer instead of making
  // people read four separate numbers and judge for themselves. Weights are
  // intentionally simple (linear, capped) so the score stays explainable —
  // useful when this needs defending in a sidang/presentation.
  function computeHealthScore(ping, loss, jitter, bwMbps) {
    const pingPenalty   = ping === null ? 45 : clamp(((ping - 30) / 270) * 45, 0, 45);
    const lossPenalty   = clamp((loss / 10) * 30, 0, 30);
    const jitterPenalty = clamp(((jitter - 10) / 90) * 15, 0, 15);
    const bwPenalty     = (bwMbps && bwMbps > 0) ? clamp(((10 - bwMbps) / 10) * 10, 0, 10) : 0;
    return Math.round(clamp(100 - pingPenalty - lossPenalty - jitterPenalty - bwPenalty, 0, 100));
  }

  function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

  function scoreLabel(score) {
    if (score >= 90) return { text: 'Sangat Baik', cls: 'good' };
    if (score >= 75) return { text: 'Baik', cls: 'good' };
    if (score >= 55) return { text: 'Cukup', cls: 'warn' };
    if (score >= 35) return { text: 'Kurang', cls: 'warn' };
    return { text: 'Buruk', cls: 'bad' };
  }

  function renderHealthScore(ping, loss, jitter) {
    const bwForScore = bwSource !== 'none' ? lastBw : null;
    const score = computeHealthScore(ping, loss, jitter, bwForScore);
    const { cls } = scoreLabel(score);
    scoreValue.textContent = score;
    scoreRing.className = `health-score-ring ${cls}`;

    // Persist periodically (not every tick) so Modul 4's trend calculation
    // has history to read without flooding localStorage with near-duplicate
    // snapshots every 5 seconds.
    if (tickCount % 3 === 0) {
      Store.addHealthSnapshot({ score, ping, loss, jitter, timestamp: new Date().toLocaleString('id-ID') });
    }
    return score;
  }

  // ─── Render: Status Banner ────────────────────────────────────────────────
  function renderBanner(ping, loss) {
    let cls, dotCls, titleText, titleColor, descText;
    const targetName = PING_TARGETS[targetIdx].name;

    if (ping === null && tickCount > 0) {
      cls = 'critical'; dotCls = 'status-dot-red';
      titleText = 'Server Tidak Terjangkau'; titleColor = '#F87171';
      descText = `Target: ${targetName} — semua ping gagal. Ini bisa berarti internet kamu terputus, atau server/domain ini diblokir oleh firewall jaringan — coba ganti server target di atas.`;
    } else if (loss >= 8 || (ping !== null && ping >= 300)) {
      cls = 'critical'; dotCls = 'status-dot-red';
      titleText = 'Koneksi Kritis'; titleColor = '#F87171';
      descText = `Target: ${targetName} — packet loss ${fmt(loss)}%${ping !== null ? ', ping ' + Math.round(ping) + ' ms' : ''} — koneksi sangat terganggu.`;
    } else if (loss >= 2 || (ping !== null && ping >= 80)) {
      cls = 'degraded'; dotCls = 'status-dot-yellow';
      titleText = 'Performa Menurun'; titleColor = '#FBBF24';
      descText = `Target: ${targetName} — ${ping !== null ? 'ping ' + Math.round(ping) + ' ms, ' : ''}packet loss ${fmt(loss)}% — perlu diperhatikan.`;
    } else {
      cls = 'healthy'; dotCls = 'status-dot-green';
      titleText = 'Koneksi Sehat'; titleColor = '#34D399';
      descText = ping !== null
        ? `Target: ${targetName} — ping ${Math.round(ping)} ms, packet loss ${fmt(loss)}% — kondisi jaringan normal.`
        : 'Menginisialisasi — pengukuran pertama sedang berjalan.';
    }

    statusBanner.className = `network-status-banner ${cls} mb-6`;
    statusDot.className = `status-dot ${dotCls}`;
    statusTitle.textContent = titleText;
    statusTitle.style.color = titleColor;
    statusDesc.textContent  = descText;
  }

  // ─── Render: Metric Card Colors ───────────────────────────────────────────
  function setMetricColor(el, card, value, warnThresh, critThresh) {
    let color = '#34D399';
    card.classList.remove('warn', 'crit');
    if (value >= critThresh)       { color = '#F87171'; card.classList.add('crit'); }
    else if (value >= warnThresh)  { color = '#FBBF24'; card.classList.add('warn'); }
    el.style.color = color;
  }

  // ─── Render: This Device's Stats ──────────────────────────────────────────
  function renderDevices() {
    const { name, icon, browser } = getThisDeviceInfo();

    deviceTableBody.innerHTML = '';

    const thisDl  = bwSource === 'measured'  ? `${fmt(lastBw)} Mbps`
                  : bwSource === 'estimated' ? `~${fmt(lastBw)} Mbps`
                  : '—';
    const thisLat = lastRealPing !== null ? `${Math.round(lastRealPing)} ms` : '—';
    const trThis  = document.createElement('tr');
    trThis.className = 'real-device-row';
    trThis.innerHTML = `
      <td>
        <span class="mr-1">${icon}</span>
        <span>${escapeHtml(name)}</span>
      </td>
      <td><span class="badge badge-online">Online</span></td>
      <td class="text-signal">${thisDl}</td>
      <td class="text-signal">${thisLat}</td>
      <td class="text-muted text-xs">${escapeHtml(browser)}</td>
    `;
    deviceTableBody.appendChild(trThis);
  }

  // ─── Server Selector Tabs ─────────────────────────────────────────────────
  function buildServerTabs() {
    serverTabsEl.innerHTML = '';
    PING_TARGETS.forEach((t, i) => {
      const btn = document.createElement('button');
      btn.className = `server-tab${i === 0 ? ' active' : ''}`;
      btn.textContent = t.name;
      btn.title = `${t.url}  —  ${t.region}`;
      btn.dataset.idx = i;
      btn.setAttribute('aria-pressed', i === 0 ? 'true' : 'false');
      btn.addEventListener('click', () => {
        if (targetIdx === i) return;
        targetIdx = i;
        serverTabsEl.querySelectorAll('.server-tab').forEach((b, bi) => {
          b.classList.toggle('active', bi === i);
          b.setAttribute('aria-pressed', bi === i ? 'true' : 'false');
        });
        pushAlert('info', `Server target diubah ke ${t.name} — ${t.region}`);
      });
      serverTabsEl.appendChild(btn);
    });
  }

  // ─── Chart ────────────────────────────────────────────────────────────────
  function buildChart() {
    const ctx = document.getElementById('healthChart').getContext('2d');
    chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: timeLabels,
        datasets: [
          {
            label: 'Ping (ms)',
            data: pingHistory,
            borderColor: '#34D399',
            backgroundColor: 'rgba(52,211,153,0.08)',
            fill: true, tension: 0.35, pointRadius: 0, borderWidth: 2,
            yAxisID: 'yPing', spanGaps: true,
          },
          {
            label: 'Packet Loss (%)',
            data: lossHistory,
            borderColor: '#FBBF24',
            backgroundColor: 'rgba(251,191,36,0.06)',
            fill: true, tension: 0.35, pointRadius: 0, borderWidth: 2,
            yAxisID: 'yLoss', spanGaps: true,
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: {
            ticks: { color: '#8B96AF', maxRotation: 0, autoSkip: true, maxTicksLimit: 8, font: { family: 'JetBrains Mono', size: 10 } },
            grid: { color: '#1D2740' },
          },
          yPing: {
            position: 'left', beginAtZero: true,
            ticks: { color: '#34D399', font: { family: 'JetBrains Mono', size: 10 } },
            grid: { color: '#1D2740' },
            title: { display: true, text: 'Ping (ms)', color: '#34D399', font: { size: 10 } },
          },
          yLoss: {
            position: 'right', beginAtZero: true, max: 105,
            ticks: { color: '#FBBF24', font: { family: 'JetBrains Mono', size: 10 } },
            grid: { drawOnChartArea: false },
            title: { display: true, text: 'Loss (%)', color: '#FBBF24', font: { size: 10 } },
          },
        },
        plugins: {
          legend: { labels: { color: '#E7ECF5', font: { family: 'Inter', size: 11 }, usePointStyle: true, pointStyleWidth: 8 } },
          tooltip: { backgroundColor: '#161D2F', borderColor: '#26304A', borderWidth: 1, titleColor: '#E7ECF5', bodyColor: '#8B96AF' },
        },
      },
    });
  }

  // ─── Main Tick ────────────────────────────────────────────────────────────
  async function tick() {
    if (measuring) return;
    measuring = true;
    measuringStatus.classList.remove('hidden');

    try {
      // 1. Real ping measurements (parallel batch)
      const samples = await runPingBatch();
      const ping    = calcAvgPing(samples);
      const loss    = calcLoss(samples);
      const jitter  = calcJitter(samples);

      if (ping !== null) lastRealPing = ping;

      // 2. Update metric cards
      if (ping !== null) {
        metricPing.textContent = Math.round(ping);
        setMetricColor(metricPing, cardPing, ping, 80, 200);
      } else {
        metricPing.textContent = '∞';
        metricPing.style.color = '#F87171';
        cardPing.classList.remove('warn');
        cardPing.classList.add('crit');
      }

      metricLoss.textContent   = fmt(loss);
      setMetricColor(metricLoss, cardLoss, loss, 2, 8);

      metricJitter.textContent = fmt(jitter);
      setMetricColor(metricJitter, cardJitter, jitter, 20, 50);

      // 3. Rolling chart update
      pingHistory.push(ping !== null ? Math.round(ping) : null);
      pingHistory.shift();
      lossHistory.push(parseFloat(fmt(loss)));
      lossHistory.shift();
      timeLabels.push(nowLabel());
      timeLabels.shift();

      if (chart) {
        chart.data.labels = [...timeLabels];
        chart.data.datasets[0].data = [...pingHistory];
        chart.data.datasets[1].data = [...lossHistory];
        chart.update('none');
      }

      // 4. Status banner + composite health score
      renderBanner(ping, loss);
      renderHealthScore(ping, loss, jitter);

      // 5. Auto alerts (only after first real measurement)
      if (tickCount > 0) {
        const roundPing = ping !== null ? Math.round(ping) : null;
        const prevRound = prevPing !== null ? Math.round(prevPing) : null;

        if (ping === null && prevPing !== null) {
          pushAlert('crit', 'Semua ping gagal — koneksi internet terputus!');
        } else if (ping !== null && prevPing === null) {
          pushAlert('info', `Koneksi pulih — ping ${Math.round(ping)} ms`);
        } else if (roundPing !== null && prevRound !== null) {
          if (roundPing > 250 && prevRound <= 250)  pushAlert('crit', `Ping melonjak ke ${roundPing} ms!`);
          else if (roundPing > 100 && prevRound <= 100) pushAlert('warn', `Ping naik ke ${roundPing} ms`);
          else if (roundPing <= 100 && prevRound > 100) pushAlert('info', `Ping kembali normal: ${roundPing} ms`);
        }

        if (loss >= 8 && prevLoss < 8)            pushAlert('crit', `Packet loss kritis: ${fmt(loss)}%`);
        else if (loss >= 2 && prevLoss < 2)        pushAlert('warn', `Packet loss meningkat: ${fmt(loss)}%`);
        else if (loss < 2 && prevLoss >= 2)        pushAlert('info', `Packet loss kembali normal: ${fmt(loss)}%`);
      }
      prevPing = ping;
      prevLoss = loss;

      // 6. Download bandwidth test (first tick + every BW_TICK_INTERVAL ticks)
      const shouldMeasureBw = (tickCount === 0) || (tickCount % BW_TICK_INTERVAL === 0);
      if (shouldMeasureBw && !bwMeasuring) {
        runBandwidthMeasure(); // intentionally not awaited — runs in background
      }

      // 7. Connection info panel (reads navigator.connection)
      updateConnectionPanel();

      // 8. Device table (every 3 ticks to avoid excessive flicker)
      if (tickCount % 3 === 0) renderDevices();

      tickCount++;
    } finally {
      measuring = false;
      measuringStatus.classList.add('hidden');
    }
  }

  // ─── Uptime Counter ───────────────────────────────────────────────────────
  function startUptime() {
    uptimeId = setInterval(() => {
      if (running) { uptimeSec++; uptimeDisplay.textContent = fmtUptime(uptimeSec); }
    }, 1000);
  }

  // ─── Controls ─────────────────────────────────────────────────────────────
  function startMonitoring() {
    if (intervalId) return;
    intervalId = setInterval(tick, TICK_MS);
    tick(); // run immediately on start
  }

  function pauseMonitoring() {
    clearInterval(intervalId);
    intervalId = null;
  }

  toggleBtn.addEventListener('click', () => {
    running = !running;
    if (running) {
      toggleLabel.textContent = 'Pause';
      toggleIcon.innerHTML = '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>';
      liveIndicator.classList.remove('paused');
      liveLabel.textContent = 'LIVE';
      startMonitoring();
    } else {
      toggleLabel.textContent = 'Resume';
      toggleIcon.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"/>';
      liveIndicator.classList.add('paused');
      liveLabel.textContent = 'PAUSED';
      pauseMonitoring();
    }
  });

  resetBtn.addEventListener('click', () => {
    pingHistory.fill(null);
    lossHistory.fill(null);
    timeLabels.fill('');
    alertCount = 0; uptimeSec = 0; tickCount = 0;
    prevPing = null; prevLoss = 0; lastBw = null; lastRealPing = null; bwSource = 'none';

    alertLog.innerHTML = '<div class="text-xs text-muted text-center py-6 italic">Monitoring berjalan — menunggu event…</div>';
    alertCountEl.textContent = '0 event';
    alertCountEl.className = 'badge badge-good';
    uptimeDisplay.textContent = '00:00:00';

    [metricPing, metricLoss, metricJitter, metricBw].forEach(el => {
      el.textContent = '—';
      el.style.color = '#34D399';
      el.style.opacity = '1';
    });
    [cardPing, cardLoss, cardJitter].forEach(c => c.classList.remove('warn', 'crit'));
    bwNote.textContent = 'Mbps';

    if (chart) {
      chart.data.datasets[0].data = [...pingHistory];
      chart.data.datasets[1].data = [...lossHistory];
      chart.data.labels = [...timeLabels];
      chart.update('none');
    }

    renderBanner(null, 0);
    scoreValue.textContent = '—';
    scoreRing.className = 'health-score-ring';
    updateConnectionPanel();
    renderDevices();
    pushAlert('info', 'Data direset. Monitoring dimulai ulang.');
  });

  // ─── Session Report (print / save as PDF) ─────────────────────────────────
  // Builds a printable summary from whatever is currently on screen and
  // opens the browser print dialog — "Save as PDF" there produces a real
  // file without needing a PDF-generation library.
  reportBtn.addEventListener('click', () => {
    const target = PING_TARGETS[targetIdx];
    const score = scoreValue.textContent;
    const { text: scoreText } = scoreLabel(Number(score) || 0);
    const critAlerts = alertLog.querySelectorAll('.alert-badge-crit').length;
    const warnAlerts = alertLog.querySelectorAll('.alert-badge-warn').length;

    printReport.innerHTML = `
      <h1>Laporan Sesi Monitoring Jaringan — NetOptima</h1>
      <p class="print-meta">Dibuat: ${new Date().toLocaleString('id-ID')} &middot; Server target: ${escapeHtml(target.name)} (${escapeHtml(target.region)}) &middot; Durasi sesi: ${fmtUptime(uptimeSec)}</p>
      <h2>Ringkasan</h2>
      <table>
        <tr><th>Skor Kesehatan Jaringan</th><td>${score} / 100 — ${scoreText}</td></tr>
        <tr><th>Ping Terakhir</th><td>${metricPing.textContent} ms</td></tr>
        <tr><th>Packet Loss</th><td>${metricLoss.textContent} %</td></tr>
        <tr><th>Jitter</th><td>${metricJitter.textContent} ms</td></tr>
        <tr><th>Kecepatan Download</th><td>${metricBw.textContent} Mbps</td></tr>
        <tr><th>Total Event Alert</th><td>${alertCount} (${critAlerts} kritis, ${warnAlerts} peringatan)</td></tr>
      </table>
      <h2>Perangkat Ini</h2>
      <table>
        <tr><th>Perangkat</th><th>Status</th><th>Download</th><th>Latency</th><th>Browser</th></tr>
        ${Array.from(deviceTableBody.querySelectorAll('tr')).map(row => {
          const cells = row.querySelectorAll('td');
          return `<tr><td>${cells[0]?.textContent.trim() || ''}</td><td>${cells[1]?.textContent.trim() || ''}</td><td>${cells[2]?.textContent.trim() || ''}</td><td>${cells[3]?.textContent.trim() || ''}</td><td>${cells[4]?.textContent.trim() || ''}</td></tr>`;
        }).join('')}
      </table>
    `;
    window.print();
  });

  // ─── Init ─────────────────────────────────────────────────────────────────
  buildServerTabs();
  buildChart();
  updateConnectionPanel();
  renderDevices();
  startMonitoring();
  startUptime();
  pushAlert('info', `Network Monitoring dimulai — target: ${PING_TARGETS[0].name} (${PING_TARGETS[0].region})`);
})();
