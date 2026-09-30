// Offline unit tests for the deterministic Code nodes (no n8n, no LLM).
// Runs each node's source with stubbed $json / $() / $execution, the way n8n's "run once for each item" mode does.
// Usage: node scripts/test-code-nodes.js
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const src = (name) => fs.readFileSync(path.join(ROOT, 'workflow', 'code', `${name}.js`), 'utf8');

function runNode(name, json, nodeOutputs = {}) {
  const $ = (nodeName) => ({ first: () => ({ json: nodeOutputs[nodeName] }) });
  const fn = new Function('$json', '$', '$execution', src(name));
  return fn(json, $, { id: '42' }).json;
}

const normalize = (source, message) => runNode('02-normalize-request', { body: { source, message } });

function aiResponse(overrides = {}) {
  const ai = {
    core_issue: 'x',
    identifiers: { account_ids: [], invoice_numbers: [], error_codes: [], urls: [], other: [] },
    billing: { billed_amount: null, expected_amount: null, currency: null },
    affected_scope: 'unknown',
    urgency_signals: [],
    urgency_level: 'Low',
    category_rationale: 'because',
    category: 'Technical Question',
    priority: 'Low',
    confidence: 0.9,
    summary: 'First sentence. Second sentence.',
    ...overrides,
  };
  return { model: 'openai/gpt-oss-120b', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(ai) } }] };
}

// Full deterministic chain after the LLM: 05 -> 06 -> 07 -> 08
function pipeline(message, aiOverrides, source = 'email') {
  const req = normalize(source, message);
  const ctx = { '02 Normalize Request': req };
  const validated = runNode('05-validate-ai-output', aiResponse(aiOverrides), ctx);
  const queued = runNode('06-determine-queue', validated, ctx);
  const escalated = runNode('07-apply-escalation-rules', queued, ctx);
  return runNode('08-build-final-record', escalated, ctx).record;
}
const codes = (record) => record.escalation.reasons.map((r) => r.code).sort();

const tests = {
  'normalize: maps "Web Form" to web_form and trims': () => {
    const r = normalize('Web Form', '  hello  ');
    assert.equal(r.source, 'web_form');
    assert.equal(r.raw_message, 'hello');
    assert.equal(r.valid, true);
  },
  'normalize: empty message is invalid': () => {
    assert.equal(normalize('email', '   ').valid, false);
  },
  'normalize: oversized message is invalid': () => {
    assert.equal(normalize('email', 'a'.repeat(5001)).valid, false);
  },
  'normalize: unknown source is kept with a warning, not rejected': () => {
    const r = normalize('fax', 'hi');
    assert.equal(r.valid, true);
    assert.equal(r.source, 'unknown');
    assert.equal(r.input_warnings.length, 1);
  },
  'routing: confident Bug Report -> Engineering, not escalated': () => {
    const r = pipeline('I get a 403 error', { category: 'Bug Report', confidence: 0.85 });
    assert.equal(r.routing.queue, 'Engineering');
    assert.equal(r.escalation.required, false);
  },
  'escalation: confidence 0.69 -> LOW_CONFIDENCE, Human Review, intended queue kept': () => {
    const r = pipeline('Is there a way to do X?', { category: 'Technical Question', confidence: 0.69 });
    assert.deepEqual(codes(r), ['LOW_CONFIDENCE']);
    assert.equal(r.routing.queue, 'Human Review');
    assert.equal(r.routing.intended_queue, 'Technical Support');
  },
  'escalation: confidence exactly 0.70 is NOT low confidence': () => {
    const r = pipeline('Is there a way to do X?', { confidence: 0.7 });
    assert.equal(r.escalation.required, false);
  },
  'escalation: Incident/Outage without the word "outage" -> INCIDENT only (T1)': () => {
    const r = pipeline('Your dashboard stopped loading for us around 2pm EST. Checked our end — it\'s definitely on yours. Multiple users affected.',
      { category: 'Incident/Outage', priority: 'High', confidence: 0.9 });
    assert.deepEqual(codes(r), ['INCIDENT']);
    assert.equal(r.routing.queue, 'Human Review');
    assert.equal(r.routing.intended_queue, 'Engineering');
  },
  'escalation: keyword rule fires even if the LLM says Bug Report': () => {
    const r = pipeline('The platform is down for all users since 9am', { category: 'Bug Report', confidence: 0.9 });
    assert.deepEqual(codes(r), ['OUTAGE_KEYWORDS']);
  },
  'escalation: "outage" keyword': () => {
    assert.deepEqual(codes(pipeline('Is there an outage?', {})), ['OUTAGE_KEYWORDS']);
  },
  'escalation: keyword rule does not fire on "download" or "shutdown"': () => {
    assert.equal(pipeline('The download of the shutdown report fails', {}).escalation.required, false);
  },
  'billing: $1,240 vs $980 -> discrepancy 260, NOT escalated (D-08, T2)': () => {
    const msg = 'Invoice #8821 shows a charge of $1,240 but our contract rate is $980/month.';
    const r = pipeline(msg, { category: 'Billing Issue', priority: 'Medium', confidence: 0.95,
      identifiers: { account_ids: [], invoice_numbers: ['8821'], error_codes: [], urls: [], other: [] },
      billing: { billed_amount: 1240, expected_amount: 980, currency: 'USD' } });
    assert.equal(r.enrichment.billing.discrepancy, 260);
    assert.equal(r.escalation.required, false);
    assert.equal(r.routing.queue, 'Billing');
  },
  'billing: discrepancy 500.01 -> BILLING_OVER_500': () => {
    const r = pipeline('charged 1500.01 instead of 1000', { category: 'Billing Issue',
      billing: { billed_amount: 1500.01, expected_amount: 1000, currency: 'USD' } });
    assert.deepEqual(codes(r), ['BILLING_OVER_500']);
  },
  'billing: discrepancy exactly 500 -> not escalated': () => {
    const r = pipeline('charged 1500 instead of 1000', { category: 'Billing Issue',
      billing: { billed_amount: 1500, expected_amount: 1000, currency: 'USD' } });
    assert.equal(r.escalation.required, false);
  },
  'billing: only a disputed $900 charge known -> escalate conservatively': () => {
    const r = pipeline('wrong charge of $900', { category: 'Billing Issue',
      billing: { billed_amount: 900, expected_amount: null, currency: 'USD' } });
    assert.deepEqual(codes(r), ['BILLING_OVER_500']);
  },
  'billing: non-billing category -> billing is null even if the LLM filled amounts': () => {
    const r = pipeline('some bug', { category: 'Bug Report', billing: { billed_amount: 5, expected_amount: 1, currency: 'USD' } });
    assert.equal(r.enrichment.billing, null);
  },
  'grounding: invented identifier is dropped with a warning': () => {
    const r = pipeline('I get a 403 error', { category: 'Bug Report',
      identifiers: { account_ids: ['acct-999'], invoice_numbers: [], error_codes: ['403'], urls: [], other: [] } });
    assert.deepEqual(r.enrichment.identifiers.account_ids, []);
    assert.deepEqual(r.enrichment.identifiers.error_codes, ['403']);
    assert.ok(r.meta.warnings.some((w) => w.includes('acct-999')));
  },
  'validation: confidence 1.5 -> validation_failed -> AI_FAILURE -> Human Review': () => {
    const r = pipeline('hello', { confidence: 1.5 });
    assert.equal(r.meta.status, 'validation_failed');
    assert.deepEqual(codes(r), ['AI_FAILURE']);
    assert.equal(r.routing.queue, 'Human Review');
    assert.equal(r.routing.intended_queue, null);
  },
  'validation: non-JSON content -> validation_failed': () => {
    const req = normalize('email', 'hello');
    const out = runNode('05-validate-ai-output', { choices: [{ finish_reason: 'stop', message: { content: 'not json' } }] },
      { '02 Normalize Request': req });
    assert.equal(out.status, 'validation_failed');
  },
  'failure path: HTTP error -> ai_failed record in Human Review': () => {
    const req = normalize('email', 'hello');
    const ctx = { '02 Normalize Request': req };
    const failed = runNode('05e-build-failure-record', { error: { message: '429 Too Many Requests' } }, ctx);
    const r = runNode('08-build-final-record', runNode('07-apply-escalation-rules', runNode('06-determine-queue', failed, ctx), ctx), ctx).record;
    assert.equal(r.meta.status, 'ai_failed');
    assert.equal(r.routing.queue, 'Human Review');
    assert.deepEqual(codes(r), ['AI_FAILURE']);
  },
  'record: JSONL line is one line and queue file name is safe': () => {
    const req = normalize('email', 'hello');
    const ctx = { '02 Normalize Request': req };
    const out = runNode('08-build-final-record', runNode('07-apply-escalation-rules',
      runNode('06-determine-queue', runNode('05-validate-ai-output', aiResponse({ category: 'Technical Question' }), ctx), ctx), ctx), ctx);
    assert.equal(out.jsonl_line.split('\n').length, 2);
    assert.equal(out.queue_file, 'queue-technical-support.jsonl');
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log(`PASS  ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message.split('\n')[0]}`); }
}
console.log(`\n${Object.keys(tests).length - failed}/${Object.keys(tests).length} passed`);
process.exit(failed ? 1 : 0);
