// assets/js/main.js
// Shared across all pages: mobile nav toggle, HTML-escaping helper, and a
// small localStorage wrapper that replaces the PHP + SQLite backend used
// in the server-hosted version of this project. Everything here runs
// entirely in the visitor's browser — no server involved, which is what
// makes this version deployable on GitHub Pages.

// Mobile menu wiring now lives in layout.js, since it injects the header
// that contains the toggle button and menu.

// Used before inserting any dynamic string (e.g. an uploaded file name)
// into innerHTML, so the dashboard can't be tricked into rendering
// unexpected markup.
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

const STORAGE_KEYS = {
  speedtestHistory: 'netoptima_speedtest_history',
  simulationLatest: 'netoptima_simulation_latest',
  logHistory: 'netoptima_log_history',
  healthHistory: 'netoptima_health_history',
  capacityPlan: 'netoptima_capacity_plan',
};

const Store = {
  _read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (err) {
      console.error('Gagal membaca localStorage:', key, err);
      return fallback;
    }
  },
  _write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (err) {
      // Most likely the quota was exceeded — surface this clearly instead
      // of failing silently, since data just won't be saved otherwise.
      console.error('Gagal menyimpan ke localStorage:', key, err);
      return false;
    }
  },

  getSpeedtestHistory() {
    return this._read(STORAGE_KEYS.speedtestHistory, []);
  },
  addSpeedtestResult(result) {
    const history = this.getSpeedtestHistory();
    history.push(result);
    // Keep the most recent 30 entries so localStorage doesn't grow forever.
    const trimmed = history.slice(-30);
    this._write(STORAGE_KEYS.speedtestHistory, trimmed);
    return trimmed;
  },

  getSimulationLatest() {
    return this._read(STORAGE_KEYS.simulationLatest, null);
  },
  setSimulationLatest(result) {
    this._write(STORAGE_KEYS.simulationLatest, result);
  },

  getLogHistory() {
    return this._read(STORAGE_KEYS.logHistory, []);
  },
  addLogAnalysis(entry) {
    const history = this.getLogHistory();
    history.push(entry);
    // Keep the most recent 15 — each entry includes a summary, not the raw
    // uploaded file, so this stays well within localStorage limits.
    const trimmed = history.slice(-15);
    this._write(STORAGE_KEYS.logHistory, trimmed);
    return trimmed;
  },

  getHealthHistory() {
    return this._read(STORAGE_KEYS.healthHistory, []);
  },
  addHealthSnapshot(entry) {
    const history = this.getHealthHistory();
    history.push(entry);
    // Health snapshots are taken every few seconds while monitoring runs,
    // so this fills up fast — keep only the most recent 50.
    const trimmed = history.slice(-50);
    this._write(STORAGE_KEYS.healthHistory, trimmed);
    return trimmed;
  },

  // Remembers the person's last capacity-planning inputs, so returning to
  // the page doesn't mean re-typing everything from scratch.
  getCapacityPlan() {
    return this._read(STORAGE_KEYS.capacityPlan, null);
  },
  setCapacityPlan(plan) {
    this._write(STORAGE_KEYS.capacityPlan, plan);
  },

  // ─── Full backup / restore ────────────────────────────────────────────
  // Since all data lives in this browser's localStorage only, this is the
  // only way to move history between devices (e.g. HP → laptop) or keep a
  // backup before clearing browser data — without needing a server.
  exportAll() {
    const payload = {
      exported_at: new Date().toISOString(),
      app: 'netoptima',
      version: 1,
      data: {
        speedtestHistory: this.getSpeedtestHistory(),
        simulationLatest: this.getSimulationLatest(),
        logHistory: this.getLogHistory(),
        healthHistory: this.getHealthHistory(),
        capacityPlan: this.getCapacityPlan(),
      },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `netoptima-backup-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  // Merges an imported backup into whatever is already stored here, rather
  // than overwriting it — so importing on a device that already has some
  // history doesn't silently wipe it out.
  importAll(payload) {
    if (!payload || payload.app !== 'netoptima' || !payload.data) {
      throw new Error('File ini bukan file backup NetOptima yang valid.');
    }
    const d = payload.data;

    if (Array.isArray(d.speedtestHistory)) {
      const merged = this.getSpeedtestHistory().concat(d.speedtestHistory).slice(-30);
      this._write(STORAGE_KEYS.speedtestHistory, merged);
    }
    if (Array.isArray(d.logHistory)) {
      const merged = this.getLogHistory().concat(d.logHistory).slice(-15);
      this._write(STORAGE_KEYS.logHistory, merged);
    }
    if (Array.isArray(d.healthHistory)) {
      const merged = this.getHealthHistory().concat(d.healthHistory).slice(-50);
      this._write(STORAGE_KEYS.healthHistory, merged);
    }
    if (d.simulationLatest) this.setSimulationLatest(d.simulationLatest);
    if (d.capacityPlan) this.setCapacityPlan(d.capacityPlan);

    return {
      speedtest: Array.isArray(d.speedtestHistory) ? d.speedtestHistory.length : 0,
      log: Array.isArray(d.logHistory) ? d.logHistory.length : 0,
      health: Array.isArray(d.healthHistory) ? d.healthHistory.length : 0,
    };
  },
};
