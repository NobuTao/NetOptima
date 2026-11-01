// tests/log-parser.test.js
//
// Manual validation for assets/js/log-parser.js: feeds it small, known
// sample logs and checks the output against hand-calculated expected
// values. This exists because a reviewer (dosen/penguji) can reasonably
// ask "how do you know the parsing logic is correct?" — this is the
// answer, runnable without installing anything beyond Node.js itself.
//
// Run with:  node tests/log-parser.test.js
// Exits with code 0 if all checks pass, 1 if any fail.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// log-parser.js is written as plain browser globals (no module.exports),
// since it's loaded via a plain <script> tag with no build step. To test
// it from Node without changing that, we run its source in the current
// VM context (not a separate sandbox realm) so the objects it returns
// share the same Object/Array prototypes as this test file — otherwise
// assert.deepStrictEqual would report mismatches on identical values
// purely because they come from different realms.
const source = fs.readFileSync(
  path.join(__dirname, '..', 'assets', 'js', 'log-parser.js'),
  'utf-8'
);
vm.runInThisContext(source, { filename: 'log-parser.js' });
const { parseLogText, summarizeLogRecords } = global;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

// ─── Sample 1: Mikrotik text log, 4 known lines ────────────────────────────
const mikrotikSample = [
  '08:00:00 firewall,info forward: proto TCP (1000->443), 192.168.1.10:1000->8.8.8.8:443, len 500',
  '08:00:05 firewall,info forward: proto UDP (2000->53), 192.168.1.10:2000->1.1.1.1:53, len 100',
  '09:15:30 firewall,info forward: proto TCP (3000->80), 192.168.1.20:3000->93.184.216.34:80, len 1400',
  'this line has no traffic arrow and should be skipped',
].join('\n');

test('parses correct number of Mikrotik lines (skips non-matching lines)', () => {
  const records = parseLogText(mikrotikSample);
  assert.strictEqual(records.length, 3);
});

test('extracts time, src_ip, dst_ip, protocol, bytes correctly from a Mikrotik line', () => {
  const records = parseLogText(mikrotikSample);
  assert.deepStrictEqual(records[0], {
    time: '08:00:00',
    src_ip: '192.168.1.10',
    dst_ip: '8.8.8.8',
    bytes: 500,
    protocol: 'TCP',
  });
});

test('handles a line with no "len" field (defaults bytes to 0)', () => {
  const records = parseLogText('10:00:00 forward: proto TCP, 10.0.0.1:1->10.0.0.2:2');
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].bytes, 0);
});

// ─── Sample 2: CSV log ──────────────────────────────────────────────────────
const csvSample = [
  'timestamp,src_ip,dst_ip,bytes,protocol',
  '11:00:00,192.168.1.5,8.8.8.8,2000,TCP',
  '12:30:00,192.168.1.6,1.1.1.1,500,UDP',
].join('\n');

test('parses CSV with standard column names', () => {
  const records = parseLogText(csvSample);
  assert.strictEqual(records.length, 2);
  assert.deepStrictEqual(records[0], {
    time: '11:00:00', src_ip: '192.168.1.5', dst_ip: '8.8.8.8', bytes: 2000, protocol: 'TCP',
  });
});

test('parses CSV with alternate column names (source/destination/size)', () => {
  const csv = 'source,destination,size,proto\n192.168.1.1,8.8.4.4,999,UDP';
  const records = parseLogText(csv);
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].src_ip, '192.168.1.1');
  assert.strictEqual(records[0].bytes, 999);
});

// ─── summarizeLogRecords: hand-calculated expected values ──────────────────
const knownRecords = [
  { time: '08:00:00', src_ip: '192.168.1.10', dst_ip: 'x', bytes: 500, protocol: 'TCP' },
  { time: '08:30:00', src_ip: '192.168.1.10', dst_ip: 'x', bytes: 300, protocol: 'TCP' },
  { time: '09:00:00', src_ip: '192.168.1.20', dst_ip: 'x', bytes: 100, protocol: 'UDP' },
];
// Hand calculation:
//   192.168.1.10 = 500 + 300 = 800 bytes, 2 packets  -> top source
//   192.168.1.20 = 100 bytes, 1 packet
//   hour 8 = 500 + 300 = 800 bytes; hour 9 = 100 bytes -> busiest_hour = 8
//   protocols: TCP x2, UDP x1

test('summarizeLogRecords ranks top source by total bytes correctly', () => {
  const summary = summarizeLogRecords(knownRecords);
  assert.strictEqual(summary.total_records, 3);
  assert.strictEqual(summary.top_sources[0].ip, '192.168.1.10');
  assert.strictEqual(summary.top_sources[0].bytes, 800);
  assert.strictEqual(summary.top_sources[0].count, 2);
});

test('summarizeLogRecords finds the correct busiest hour', () => {
  const summary = summarizeLogRecords(knownRecords);
  assert.strictEqual(summary.busiest_hour, 8);
  assert.strictEqual(summary.has_time_data, true);
});

test('summarizeLogRecords tallies protocol breakdown correctly', () => {
  const summary = summarizeLogRecords(knownRecords);
  assert.strictEqual(summary.protocol_breakdown.TCP, 2);
  assert.strictEqual(summary.protocol_breakdown.UDP, 1);
});

test('summarizeLogRecords falls back to ranking by packet count when no bytes are known', () => {
  const noByteRecords = [
    { time: '08:00:00', src_ip: 'A', dst_ip: 'x', bytes: 0, protocol: 'TCP' },
    { time: '08:00:00', src_ip: 'A', dst_ip: 'x', bytes: 0, protocol: 'TCP' },
    { time: '08:00:00', src_ip: 'B', dst_ip: 'x', bytes: 0, protocol: 'TCP' },
  ];
  const summary = summarizeLogRecords(noByteRecords);
  assert.strictEqual(summary.top_sources[0].ip, 'A');
  assert.strictEqual(summary.top_sources[0].count, 2);
});

// ─── Edge cases ──────────────────────────────────────────────────────────
test('empty input produces zero records without throwing', () => {
  const records = parseLogText('');
  assert.strictEqual(records.length, 0);
  const summary = summarizeLogRecords(records);
  assert.strictEqual(summary.total_records, 0);
  assert.strictEqual(summary.busiest_hour, null);
});

test('input with only unparsable garbage produces zero records', () => {
  const records = parseLogText('just some random text\nwith no IPs or commas at all');
  assert.strictEqual(records.length, 0);
});

// ─── Summary ────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
