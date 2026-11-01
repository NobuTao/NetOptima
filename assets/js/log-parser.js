// assets/js/log-parser.js
// Client-side port of the PHP log parser (includes/log_parser.php). Runs
// entirely in the browser via FileReader — the log file never has to be
// uploaded anywhere, since there's no server in this version.

function parseLogText(text) {
  const firstLine = (text.split(/\r?\n/, 1)[0] || '');
  const looksLikeCsv = firstLine.includes(',') && !firstLine.includes('->');

  if (looksLikeCsv) {
    const records = parseCsvLog(text);
    if (records.length > 0) {
      return records;
    }
    // Heuristic missed (e.g. a non-"forward" Mikrotik line came first) —
    // fall back to text parsing below.
  }

  return parseMikrotikTextLog(text);
}

function parseCsvLine(line) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { cur += c; }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      result.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur);
  return result;
}

function parseCsvLog(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  if (lines.length === 0) return [];

  const header = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase());
  const colIndex = {};
  header.forEach((h, i) => { colIndex[h] = i; });

  const find = (candidates) => {
    for (const c of candidates) {
      if (c in colIndex) return colIndex[c];
    }
    return null;
  };

  const iTime  = find(['timestamp', 'time', 'datetime', 'date']);
  const iSrc   = find(['src_ip', 'source', 'source_ip', 'src']);
  const iDst   = find(['dst_ip', 'destination', 'destination_ip', 'dst']);
  const iBytes = find(['bytes', 'size', 'length', 'len']);
  const iProto = find(['protocol', 'proto']);

  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvLine(lines[i]);
    records.push({
      time:     iTime !== null ? String(row[iTime] ?? '') : '',
      src_ip:   iSrc !== null ? String(row[iSrc] ?? '').trim() : '',
      dst_ip:   iDst !== null ? String(row[iDst] ?? '').trim() : '',
      bytes:    iBytes !== null ? (parseInt(String(row[iBytes] ?? '0').replace(/\D/g, ''), 10) || 0) : 0,
      protocol: iProto !== null ? String(row[iProto] ?? '').trim().toUpperCase() : 'UNKNOWN',
    });
  }
  return records;
}

function parseMikrotikTextLog(text) {
  const timePattern  = /^(\d{1,2}:\d{2}:\d{2})/;
  const protoPattern = /proto\s+([A-Za-z0-9]+)/i;
  const arrowPattern = /(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?\s*->\s*(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?/;
  const lenPattern   = /\blen[:\s]+(\d+)/i;

  const records = [];
  const lines = text.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;

    const arrow = arrowPattern.exec(line);
    if (!arrow) continue; // skip lines with no recognizable src->dst traffic

    const timeMatch = timePattern.exec(line);
    const protoMatch = protoPattern.exec(line);
    const lenMatch = lenPattern.exec(line);

    records.push({
      time: timeMatch ? timeMatch[1] : '',
      src_ip: arrow[1],
      dst_ip: arrow[3],
      bytes: lenMatch ? parseInt(lenMatch[1], 10) : 0,
      protocol: protoMatch ? protoMatch[1].toUpperCase() : 'UNKNOWN',
    });
  }
  return records;
}

function summarizeLogRecords(records) {
  const bySourceBytes = {};
  const bySourceCount = {};
  const byHour = new Array(24).fill(0);
  const byProtocol = {};
  let hasTime = false;

  for (const r of records) {
    const src = r.src_ip !== '' ? r.src_ip : 'Tidak diketahui';
    bySourceBytes[src] = (bySourceBytes[src] || 0) + r.bytes;
    bySourceCount[src] = (bySourceCount[src] || 0) + 1;

    const hm = /^(\d{1,2}):/.exec(r.time);
    if (hm) {
      const hour = parseInt(hm[1], 10);
      if (hour >= 0 && hour <= 23) {
        // Fall back to counting the event itself when byte length is
        // unknown, so the hourly chart still reflects activity.
        byHour[hour] += Math.max(r.bytes, 1);
        hasTime = true;
      }
    }

    const proto = r.protocol !== '' ? r.protocol : 'UNKNOWN';
    byProtocol[proto] = (byProtocol[proto] || 0) + 1;
  }

  const totalBytes = Object.values(bySourceBytes).reduce((a, b) => a + b, 0);
  const rankSource = totalBytes > 0 ? bySourceBytes : bySourceCount;

  const topSources = Object.entries(rankSource)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([ip]) => ({ ip, bytes: bySourceBytes[ip] || 0, count: bySourceCount[ip] || 0 }));

  const busiestHour = hasTime ? byHour.indexOf(Math.max(...byHour)) : null;

  const protocolBreakdown = Object.fromEntries(
    Object.entries(byProtocol).sort((a, b) => b[1] - a[1])
  );

  return {
    total_records: records.length,
    top_sources: topSources,
    hourly_bytes: byHour,
    busiest_hour: busiestHour,
    has_time_data: hasTime,
    protocol_breakdown: protocolBreakdown,
  };
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateSampleLogText() {
  const ips = ['192.168.10.11', '192.168.10.12', '192.168.10.15', '192.168.20.5', '192.168.20.9', '192.168.30.2'];
  const protocols = ['TCP', 'UDP'];
  const dests = ['8.8.8.8', '1.1.1.1', '203.0.113.10', '203.0.113.25', '142.250.4.100'];
  const lines = [];

  for (let h = 0; h < 24; h++) {
    const eventsThisHour = (h >= 8 && h <= 16) ? randInt(8, 14) : randInt(1, 5);
    for (let e = 0; e < eventsThisHour; e++) {
      const minute = String(randInt(0, 59)).padStart(2, '0');
      const second = String(randInt(0, 59)).padStart(2, '0');
      const time = `${String(h).padStart(2, '0')}:${minute}:${second}`;
      const src = ips[randInt(0, ips.length - 1)];
      const dst = dests[randInt(0, dests.length - 1)];
      const proto = protocols[randInt(0, protocols.length - 1)];
      const sport = randInt(1024, 65000);
      const dport = proto === 'TCP' ? [80, 443][randInt(0, 1)] : randInt(1024, 65000);
      const len = randInt(60, 1500);
      lines.push(`${time} firewall,info forward: in:ether1 out:ether2, proto ${proto} (${sport}->${dport}), ${src}:${sport}->${dst}:${dport}, len ${len}`);
    }
  }
  return lines.join('\n') + '\n';
}

function downloadSampleLog() {
  const content = generateSampleLogText();
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'sample_mikrotik_log.txt';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
