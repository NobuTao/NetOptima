// assets/js/capacity.js
// Pure projection math (compound growth), no measurement involved. This
// is the one module that answers "what should we prepare for" instead of
// "what is happening right now".

(() => {
  const inputCapacity = document.getElementById('inputCapacity');
  const inputUsage = document.getElementById('inputUsage');
  const inputGrowth = document.getElementById('inputGrowth');
  const inputHorizon = document.getElementById('inputHorizon');
  const calcBtn = document.getElementById('calcBtn');
  const fillFromSpeedtestBtn = document.getElementById('fillFromSpeedtestBtn');
  const formError = document.getElementById('formError');
  const resultSection = document.getElementById('resultSection');
  const verdictBanner = document.getElementById('verdictBanner');
  const criticalMonth = document.getElementById('criticalMonth');
  const finalUsage = document.getElementById('finalUsage');
  const recommendedCapacity = document.getElementById('recommendedCapacity');

  let chart = null;

  function showError(msg) {
    formError.textContent = msg;
    formError.classList.remove('hidden');
  }
  function clearError() {
    formError.textContent = '';
    formError.classList.add('hidden');
  }

  // Prefill from a saved plan, or from Speed Test history, so returning
  // users (or a demo running for a while) don't start from a blank form.
  const saved = Store.getCapacityPlan();
  if (saved) {
    inputCapacity.value = saved.capacity;
    inputUsage.value = saved.usage;
    inputGrowth.value = saved.growth;
    inputHorizon.value = saved.horizon;
  }

  fillFromSpeedtestBtn.addEventListener('click', () => {
    const history = Store.getSpeedtestHistory();
    if (history.length === 0) {
      showError('Belum ada riwayat Speed Test. Jalankan Speed Test dulu di Modul 1, atau isi manual di bawah.');
      return;
    }
    clearError();
    const avg = history.reduce((s, r) => s + r.download_mbps, 0) / history.length;
    inputUsage.value = avg.toFixed(1);
  });

  function projectUsage(usageNow, growthPct, horizonMonths) {
    const rate = growthPct / 100;
    return Array.from({ length: horizonMonths + 1 }, (_, n) => usageNow * Math.pow(1 + rate, n));
  }

  function calculate() {
    const capacity = parseFloat(inputCapacity.value);
    const usageNow = parseFloat(inputUsage.value);
    const growth = parseFloat(inputGrowth.value);
    const horizon = parseInt(inputHorizon.value, 10);

    if (!capacity || !usageNow || capacity <= 0 || usageNow <= 0) {
      showError('Isi kapasitas dan pemakaian saat ini dengan angka lebih besar dari 0.');
      return;
    }
    clearError();

    Store.setCapacityPlan({ capacity, usage: usageNow, growth, horizon });

    const projection = projectUsage(usageNow, growth, horizon);
    const criticalIdx = projection.findIndex(v => v > capacity);
    const finalValue = projection[projection.length - 1];

    resultSection.classList.remove('hidden');

    // ─── Verdict banner ───────────────────────────────────────────────────
    if (criticalIdx === -1) {
      verdictBanner.className = 'network-status-banner healthy';
      verdictBanner.innerHTML = `
        <span class="status-dot status-dot-green"></span>
        <div class="flex-1 min-w-0">
          <p class="font-display font-semibold text-signal text-base">Kapasitas Diperkirakan Cukup</p>
          <p class="text-xs text-muted mt-0.5">Dalam ${horizon} bulan ke depan, proyeksi pemakaian tidak melampaui kapasitas ${capacity} Mbps saat ini.</p>
        </div>`;
    } else if (criticalIdx <= 3) {
      verdictBanner.className = 'network-status-banner critical';
      verdictBanner.innerHTML = `
        <span class="status-dot status-dot-red"></span>
        <div class="flex-1 min-w-0">
          <p class="font-display font-semibold text-base" style="color:#F87171">Perlu Tindakan Segera</p>
          <p class="text-xs text-muted mt-0.5">Kapasitas diperkirakan terlampaui dalam ${criticalIdx} bulan — sangat mendesak untuk direncanakan.</p>
        </div>`;
    } else {
      verdictBanner.className = 'network-status-banner degraded';
      verdictBanner.innerHTML = `
        <span class="status-dot status-dot-yellow"></span>
        <div class="flex-1 min-w-0">
          <p class="font-display font-semibold text-base" style="color:#FBBF24">Perlu Direncanakan</p>
          <p class="text-xs text-muted mt-0.5">Kapasitas diperkirakan terlampaui sekitar bulan ke-${criticalIdx}. Ada waktu untuk merencanakan upgrade.</p>
        </div>`;
    }

    // ─── Stat cards ─────────────────────────────────────────────────────
    criticalMonth.textContent = criticalIdx === -1 ? `> ${horizon} bulan` : `Bulan ke-${criticalIdx}`;
    criticalMonth.className = 'stat-value text-2xl font-semibold ' + (criticalIdx === -1 ? 'text-signal' : criticalIdx <= 3 ? 'text-alert' : 'text-upload');

    finalUsage.textContent = `${finalValue.toFixed(1)} Mbps`;

    // Recommend the next capacity with a ~20% safety buffer over whatever
    // triggers the shortfall (or over the final projected value if the
    // horizon is never exceeded, as a forward-looking suggestion).
    const basisForRecommendation = criticalIdx === -1 ? finalValue : projection[criticalIdx];
    const recommended = Math.ceil((basisForRecommendation * 1.2) / 5) * 5; // round up to nearest 5 Mbps
    recommendedCapacity.textContent = `${recommended} Mbps`;

    // ─── Chart ──────────────────────────────────────────────────────────
    const labels = projection.map((_, n) => `Bln ${n}`);
    const capacityLine = projection.map(() => capacity);

    const ctx = document.getElementById('capacityChart').getContext('2d');
    if (chart) chart.destroy();
    chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: `Kapasitas Saat Ini (${capacity} Mbps)`, data: capacityLine, borderColor: '#8B96AF', borderDash: [6, 4], pointRadius: 0 },
          { label: 'Proyeksi Pemakaian', data: projection, borderColor: '#C084FC', backgroundColor: 'rgba(192,132,252,0.1)', fill: true, tension: 0.3 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { ticks: { color: '#8B96AF', maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }, grid: { color: '#1D2740' } },
          y: { ticks: { color: '#8B96AF' }, grid: { color: '#1D2740' }, beginAtZero: true, title: { display: true, text: 'Mbps', color: '#8B96AF' } },
        },
        plugins: { legend: { labels: { color: '#E7ECF5' } } },
      },
    });
  }

  calcBtn.addEventListener('click', calculate);
  if (saved) calculate(); // auto-run once if there's a saved plan to show
})();
