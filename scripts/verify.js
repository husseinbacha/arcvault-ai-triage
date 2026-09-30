// Offline consistency checks for the repository. No network, no n8n, no LLM calls, never writes files.
// Usage: node scripts/verify.js            (exit code 0 = all checks passed)
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

let failures = 0;
function check(name, fn) {
  try {
    const detail = fn();
    console.log(`PASS  ${name}${detail ? ` (${detail})` : ''}`);
  } catch (e) {
    failures++;
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// Files published with the repository (git-tracked if in a git checkout, otherwise every file on disk).
function publicFiles() {
  try {
    return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    const out = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
      if (e.name === '.git' || e.name === 'node_modules') return;
      const p = path.join(d, e.name);
      e.isDirectory() ? walk(p) : out.push(rel(p));
    });
    walk(ROOT);
    return out;
  }
}
const files = publicFiles().filter((f) => exists(f));

// ---------------------------------------------------------------------------------------------------------------
check('JSON files parse', () => {
  const json = files.filter((f) => f.endsWith('.json'));
  json.forEach((f) => { try { JSON.parse(read(f)); } catch (e) { throw new Error(`${f}: ${e.message}`); } });
  return `${json.length} files`;
});

const jsonl = (f) => read(f).split('\n').filter((l) => l.trim()).map((l, i) => {
  try { return JSON.parse(l); } catch (e) { throw new Error(`${f} line ${i + 1}: ${e.message}`); }
});
check('JSONL files parse (one JSON object per line)', () => {
  const list = files.filter((f) => f.endsWith('.jsonl'));
  const n = list.reduce((sum, f) => sum + jsonl(f).length, 0);
  return `${list.length} files, ${n} lines`;
});

// ---------------------------------------------------------------------------------------------------------------
const ACTIVE_PROMPT_FILE = 'prompts/triage-system-prompt.md';
const SCHEMA_FILE = 'prompts/triage-response-schema.json';
const schema = JSON.parse(read(SCHEMA_FILE));

check('prompts.md reproduces the active prompt exactly and names the active version', () => {
  const doc = read('prompts/prompts.md');
  const block = doc.split('## Active production prompt')[1].split('```text\n')[1].split('\n```')[0];
  assert(block.replace(/\r/g, '') === read(ACTIVE_PROMPT_FILE).trim().replace(/\r/g, ''), 'documented prompt differs from the active file');
  const version = read('workflow/code/08-build-final-record.js').match(/PROMPT_VERSION = '([^']+)'/)[1];
  assert(doc.includes(`Active version: \`${version}\``), `prompts.md does not declare ${version} as active`);
  return version;
});

check('LLM response schema is strict-mode compatible', () => {
  let objects = 0;
  const walk = (node, at) => {
    if (node.type === 'object') {
      objects++;
      assert(node.additionalProperties === false, `${at}: additionalProperties must be false`);
      const keys = Object.keys(node.properties || {});
      assert(JSON.stringify([...keys].sort()) === JSON.stringify([...(node.required || [])].sort()),
        `${at}: every property must be required`);
      keys.forEach((k) => walk(node.properties[k], `${at}.${k}`));
    }
    if (node.items) walk(node.items, `${at}[]`);
  };
  walk(schema, '$');
  return `${objects} objects checked`;
});

// Validates a final record against the documented record contract (docs/architecture.md).
const CATS = ['Bug Report', 'Feature Request', 'Billing Issue', 'Technical Question', 'Incident/Outage'];
const LEVELS = ['Low', 'Medium', 'High'];
const QUEUES = ['Engineering', 'Product', 'Billing', 'Technical Support', 'Human Review'];
function validateRecord(r, where) {
  const t = (cond, msg) => assert(cond, `${where}: ${msg}`);
  t(/^req_/.test(r.request_id), 'request_id');
  t(!Number.isNaN(Date.parse(r.received_at)), 'received_at');
  t(['email', 'web_form', 'support_portal', 'unknown'].includes(r.source), 'source');
  t(typeof r.raw_message === 'string' && r.raw_message.length > 0, 'raw_message');
  t(QUEUES.includes(r.routing?.queue), `routing.queue "${r.routing?.queue}"`);
  t(typeof r.escalation?.required === 'boolean' && Array.isArray(r.escalation.reasons), 'escalation');
  t(r.escalation.required === (r.routing.queue === 'Human Review'), 'escalated <=> Human Review');
  t(['ok', 'ai_failed', 'validation_failed'].includes(r.meta?.status), 'meta.status');
  if (r.meta.status === 'ok') {
    t(CATS.includes(r.classification?.category), 'category');
    t(LEVELS.includes(r.classification.priority), 'priority');
    t(typeof r.classification.confidence === 'number' && r.classification.confidence >= 0 && r.classification.confidence <= 1, 'confidence');
    t(typeof r.enrichment?.core_issue === 'string', 'core_issue');
    for (const k of ['account_ids', 'invoice_numbers', 'error_codes', 'urls', 'other']) {
      t(Array.isArray(r.enrichment.identifiers?.[k]), `identifiers.${k}`);
      r.enrichment.identifiers[k].forEach((v) => t(r.raw_message.toLowerCase().includes(v.toLowerCase()), `ungrounded identifier "${v}"`));
    }
    t(LEVELS.includes(r.enrichment.urgency?.level), 'urgency.level');
    t((r.enrichment.billing === null) === (r.classification.category !== 'Billing Issue'), 'billing only for Billing Issue');
  } else {
    t(r.escalation.reasons.some((x) => x.code === 'AI_FAILURE'), 'failed record must carry AI_FAILURE');
  }
  t(typeof r.summary === 'string' && r.summary.length > 0, 'summary');
}

const OUTPUT_ARRAYS = ['output/processed-requests.json', 'output/edge-case-results.json', 'output/extra-case-results.json',
  'output/summary-eval-results.json', 'output/evidence-rate-limit-failsafe.json'];
check('Output records match the record contract', () => {
  let n = 0;
  for (const f of OUTPUT_ARRAYS.filter(exists)) {
    JSON.parse(read(f)).forEach((r, i) => { if (r.error === 'invalid_request') return; validateRecord(r, `${f}[${i}]`); n++; });
  }
  const log = jsonl('output/triage-log.jsonl');
  log.forEach((r, i) => { validateRecord(r, `triage-log line ${i + 1}`); n++; });
  return `${n} records`;
});

check('Five required samples match the expected outcomes', () => {
  const expected = [
    ['Bug Report', 'Medium', 'Engineering', false],
    ['Feature Request', 'Low', 'Product', false],
    ['Billing Issue', 'Medium', 'Billing', false],
    ['Technical Question', 'Low', 'Technical Support', false],
    ['Incident/Outage', 'High', 'Human Review', true],
  ];
  const recs = JSON.parse(read('output/processed-requests.json'));
  const samples = JSON.parse(read('test-data/sample-inputs.json'));
  assert(recs.length === 5, `expected 5 records, found ${recs.length}`);
  recs.forEach((r, i) => {
    const [cat, pri, queue, esc] = expected[i];
    assert(r.raw_message === samples[i].message, `record ${i + 1} is not sample ${i + 1} verbatim`);
    const got = [r.classification.category, r.classification.priority, r.routing.queue, r.escalation.required];
    assert(JSON.stringify(got) === JSON.stringify(expected[i]), `sample ${i + 1}: expected ${expected[i]}, got ${got}`);
    if (i === 2) assert(r.enrichment.billing.discrepancy === 260, 'sample 3 discrepancy must be 260');
    if (i === 4) assert(r.routing.intended_queue === 'Engineering', 'sample 5 intended queue must be Engineering');
  });
  return '5/5';
});

check('Every triage-log record is in exactly one queue file, matching routing.queue', () => {
  const log = jsonl('output/triage-log.jsonl');
  const queueFiles = files.filter((f) => /^output\/queue-.*\.jsonl$/.test(f));
  const where = new Map();
  for (const f of queueFiles) {
    for (const r of jsonl(f)) {
      assert(!where.has(r.request_id), `${r.request_id} appears in more than one queue file`);
      where.set(r.request_id, { f, queue: r.routing.queue });
    }
  }
  for (const r of log) {
    const w = where.get(r.request_id);
    assert(w, `${r.request_id} is in the triage log but in no queue file`);
    const expectedFile = `output/queue-${r.routing.queue.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.jsonl`;
    assert(w.f === expectedFile, `${r.request_id} (${r.routing.queue}) is in ${w.f}`);
  }
  assert(where.size === log.length, `queue files hold ${where.size} records, triage log ${log.length}`);
  return `${log.length} records, ${queueFiles.length} queue files`;
});

// ---------------------------------------------------------------------------------------------------------------
// Workflow checks: the generated and exported workflows must contain exactly the source code, prompt and schema.
const { buildWorkflow } = require('./build-workflow.js');
const prompt = read(ACTIVE_PROMPT_FILE).trim();
const CODE_NODES = {
  '02 Normalize Request': '02-normalize-request',
  '05 Validate AI Output': '05-validate-ai-output',
  '05E Build Failure Record': '05e-build-failure-record',
  '06 Determine Destination Queue': '06-determine-queue',
  '07 Apply Escalation Rules': '07-apply-escalation-rules',
  '08 Build Final Record': '08-build-final-record',
};
const loadWf = (f) => { const w = JSON.parse(read(f)); return Array.isArray(w) ? w[0] : w; };

for (const wfFile of ['workflow/arcvault-triage.json', 'workflow/arcvault-triage.exported.json']) {
  check(`${wfFile}: Code nodes match workflow/code/`, () => {
    const wf = loadWf(wfFile);
    for (const [node, file] of Object.entries(CODE_NODES)) {
      const n = wf.nodes.find((x) => x.name === node);
      assert(n, `node "${node}" missing`);
      assert(n.parameters.jsCode === read(`workflow/code/${file}.js`), `node "${node}" differs from workflow/code/${file}.js`);
    }
    return `${Object.keys(CODE_NODES).length} nodes`;
  });
  check(`${wfFile}: embedded prompt and schema match the active source files`, () => {
    const wf = loadWf(wfFile);
    const code = wf.nodes.find((x) => x.name === '04A Build AI Request').parameters.jsCode;
    const body = new Function('$json', '$', '$execution', code)({ source: 'email', raw_message: 'x' }, null, { id: 1 }).json.groq_body;
    assert(body.messages[0].content === prompt, `system prompt differs from ${ACTIVE_PROMPT_FILE}`);
    assert(JSON.stringify(body.response_format.json_schema.schema) === JSON.stringify(schema), `schema differs from ${SCHEMA_FILE}`);
    assert(body.response_format.json_schema.strict === true, 'strict mode off');
    return `${body.model}, temperature ${body.temperature}, reasoning ${body.reasoning_effort}`;
  });
}

check('Generated and exported workflows are semantically identical', () => {
  const { compareWorkflows } = require('./build-workflow.js');
  const diffs = compareWorkflows(loadWf('workflow/arcvault-triage.json'), loadWf('workflow/arcvault-triage.exported.json'));
  assert(diffs.length === 0, diffs.slice(0, 5).join('\n      '));
  return 'nodes, parameters, settings, connections';
});

check('Generated workflow is current (build-workflow --check logic)', () => {
  const { compareWorkflows, outputDirOf } = require('./build-workflow.js');
  const tracked = loadWf('workflow/arcvault-triage.json');
  const diffs = compareWorkflows(buildWorkflow({ outputDir: outputDirOf(tracked) }), tracked);
  assert(diffs.length === 0, diffs.slice(0, 5).join('\n      '));
});

// ---------------------------------------------------------------------------------------------------------------
const SECRET_PATTERNS = [
  ['Groq key', /gsk_[A-Za-z0-9]{20,}/],
  ['OpenAI-style key', /\bsk-[A-Za-z0-9]{20,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ['Private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Bearer token literal', /Bearer\s+[A-Za-z0-9._-]{24,}/],
];
check('Secret scan of repository files (values never printed)', () => {
  const hits = [];
  for (const f of files) {
    if (/\.(png|jpe?g|gif)$/i.test(f)) continue;
    const text = read(f);
    for (const [name, re] of SECRET_PATTERNS) if (re.test(text)) hits.push(`${f}: ${name}`);
  }
  assert(hits.length === 0, hits.join('; '));
  return `${files.length} files, ${SECRET_PATTERNS.length} patterns`;
});

check('Relative Markdown links resolve', () => {
  let n = 0;
  for (const f of files.filter((x) => x.endsWith('.md'))) {
    const text = read(f).replace(/```[\s\S]*?```/g, '');
    for (const m of text.matchAll(/\]\(([^)]+)\)/g)) {
      const target = m[1].split('#')[0];
      if (!target || /^[a-z]+:/i.test(target)) continue;
      n++;
      assert(exists(path.posix.join(path.posix.dirname(f), target)), `${f}: broken link ${m[1]}`);
    }
  }
  return `${n} links`;
});

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
