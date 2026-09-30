// Prints a compact table of saved triage records (no network calls).
// Usage: node scripts/show-results.js [output/processed-requests.json]
const fs = require('node:fs');
const path = require('node:path');

const file = process.argv[2] || path.join(__dirname, '..', 'output', 'processed-requests.json');
const records = JSON.parse(fs.readFileSync(file, 'utf8'));
const rows = records.map((r, i) => ({
  '#': i + 1,
  category: r.classification?.category ?? '-',
  priority: r.classification?.priority ?? '-',
  conf: r.classification?.confidence ?? '-',
  queue: r.routing?.queue ?? `HTTP 400 (${r.error})`,
  escalated: r.escalation ? (r.escalation.required ? `yes: ${r.escalation.reasons.map((x) => x.code).join(',')}` : 'no') : '-',
  prompt: r.meta?.prompt_version ?? '-',
}));
const cols = Object.keys(rows[0]);
const width = Object.fromEntries(cols.map((c) => [c, Math.max(c.length, ...rows.map((r) => String(r[c]).length))]));
const line = (r) => cols.map((c) => String(r[c]).padEnd(width[c])).join('  ');
console.log(line(Object.fromEntries(cols.map((c) => [c, c]))));
console.log(cols.map((c) => '-'.repeat(width[c])).join('  '));
rows.forEach((r) => console.log(line(r)));
