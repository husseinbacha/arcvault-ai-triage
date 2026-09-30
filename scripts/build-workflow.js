// Builds the importable n8n workflow from its sources:
//   workflow/code/*.js                   Code node sources
//   prompts/triage-system-prompt.md      active system prompt
//   prompts/triage-response-schema.json  active response schema
//
// Usage:
//   node scripts/build-workflow.js                         write workflow/arcvault-triage.json (output dir: <repo>/output)
//   node scripts/build-workflow.js --output-dir <abs dir>  same, with a different output directory
//   node scripts/build-workflow.js --check [--file <path>] compare a workflow file with the sources; never writes
//
// The output directory can also come from the ARCVAULT_OUTPUT_DIR environment variable. It must be the same directory
// n8n is allowed to write to (N8N_RESTRICT_FILE_ACCESS_TO, set by start-n8n.ps1). n8n's file nodes need resolved
// absolute paths, which is why the directory is baked into the generated workflow.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_FILE = path.join(ROOT, 'workflow', 'arcvault-triage.json');
const OUTPUT_PLACEHOLDER = '<OUTPUT_DIR>';
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Absolute, forward slashes (n8n accepts them on Windows too), no trailing slash. Forward slashes matter: in an n8n
// expression a backslash directly before "{{" escapes it, so "output\{{ ... }}" would become a literal file name.
function resolveOutputDir(dir) {
  const raw = dir || process.env.ARCVAULT_OUTPUT_DIR || path.join(ROOT, 'output');
  const resolved = path.resolve(raw).replace(/\\/g, '/').replace(/\/+$/, '');
  if (/[{}\r\n]/.test(resolved)) throw new Error(`invalid output directory: ${resolved}`);
  return resolved;
}

function buildWorkflow({ outputDir } = {}) {
  const OUTPUT_DIR = resolveOutputDir(outputDir);
  const code = (name) => read(`workflow/code/${name}.js`);
  const systemPrompt = read('prompts/triage-system-prompt.md').trim();
  const schema = JSON.parse(read('prompts/triage-response-schema.json'));
  const buildAiRequest = code('04a-build-ai-request')
    .replace('__SYSTEM_PROMPT__', () => JSON.stringify(systemPrompt))
    .replace('__RESPONSE_SCHEMA__', () => JSON.stringify(schema, null, 2));

  const X = (col) => 200 + col * 240;
  const Y_MAIN = 300;
  const Y_ALT = 520;
  const REF_RECORD = `$('08 Build Final Record').first().json`;

  const codeNode = (name, jsCode, col, y = Y_MAIN) => ({
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [X(col), y],
    parameters: { mode: 'runOnceForEachItem', jsCode },
  });

  const ifNode = (name, leftValue, col) => ({
    name,
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position: [X(col), Y_MAIN],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: `${name.slice(0, 2)}-cond`,
            leftValue,
            rightValue: '',
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
  });

  const writeNode = (name, fileName, col, y) => ({
    name,
    type: 'n8n-nodes-base.readWriteFile',
    typeVersion: 1,
    position: [X(col), y],
    parameters: { operation: 'write', fileName, dataPropertyName: 'data', options: { append: true } },
  });

  const sticky = (title, body, col, span, color) => ({
    name: title,
    type: 'n8n-nodes-base.stickyNote',
    typeVersion: 1,
    position: [X(col) - 60, 60],
    parameters: { content: `## ${title}\n${body}`, width: span * 240 - 20, height: 640, color },
  });

  const nodes = [
    sticky('Step 1 - Ingestion', 'Webhook receives `{source, message}`. Normalised; empty/oversized input gets a 400.', 0, 3, 7),
    sticky('Steps 2+3 - Classification & Enrichment', 'ONE strict-JSON Groq call (gpt-oss-120b). Code validates enums, ranges, grounds identifiers, computes billing discrepancy. Any failure -> Human Review.', 3, 3, 4),
    sticky('Step 4 - Routing', 'Category -> team queue (config map).', 6, 1, 5),
    sticky('Step 6 - Escalation', 'Named rules: LOW_CONFIDENCE, INCIDENT, OUTAGE_KEYWORDS, BILLING_OVER_500, AI_FAILURE. Escalated = Human Review INSTEAD of team queue.', 7, 1, 3),
    sticky('Step 5 - Structured Output', 'Final record -> queue file + triage-log.jsonl -> HTTP response.', 8, 6, 6),

    {
      name: '01 Intake Webhook',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [X(0), Y_MAIN],
      webhookId: '3f6c9a52-1d7e-4b8a-9f2e-5c0a7d4e1b93',
      parameters: { httpMethod: 'POST', path: 'arcvault/intake', responseMode: 'responseNode', options: {} },
    },
    codeNode('02 Normalize Request', code('02-normalize-request'), 1),
    ifNode('03 Valid Input?', '={{ $json.valid }}', 2),
    {
      name: '03E Reject Invalid Input',
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1.1,
      position: [X(2), Y_ALT],
      parameters: {
        respondWith: 'json',
        responseBody: '={{ JSON.stringify({ error: "invalid_request", request_id: $json.request_id, details: $json.input_errors }) }}',
        options: { responseCode: 400 },
      },
    },
    codeNode('04A Build AI Request', buildAiRequest, 3),
    {
      name: '04 AI Triage (Groq)',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [X(4), Y_MAIN],
      retryOnFail: true,
      maxTries: 3,
      waitBetweenTries: 2000,
      onError: 'continueErrorOutput',
      parameters: {
        method: 'POST',
        url: 'https://api.groq.com/openai/v1/chat/completions',
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.groq_body) }}',
        options: { timeout: 30000 },
      },
    },
    codeNode('05 Validate AI Output', code('05-validate-ai-output'), 5),
    codeNode('05E Build Failure Record', code('05e-build-failure-record'), 5, Y_ALT),
    codeNode('06 Determine Destination Queue', code('06-determine-queue'), 6),
    codeNode('07 Apply Escalation Rules', code('07-apply-escalation-rules'), 7),
    codeNode('08 Build Final Record', code('08-build-final-record'), 8),
    {
      name: '08B Serialize JSONL Line',
      type: 'n8n-nodes-base.convertToFile',
      typeVersion: 1.1,
      position: [X(9), Y_MAIN],
      parameters: { operation: 'toText', sourceProperty: 'jsonl_line', binaryPropertyName: 'data', options: {} },
    },
    ifNode('09 Escalation Required?', `={{ ${REF_RECORD}.record.escalation.required }}`, 10),
    // File names never come from user input: queue_file is built by node 08 from the fixed queue table.
    writeNode('10A Human Review Queue', `${OUTPUT_DIR}/queue-human-review.jsonl`, 11, 200),
    writeNode('10B Team Queue', `=${OUTPUT_DIR}/{{ ${REF_RECORD}.queue_file }}`, 11, 420),
    writeNode('11 Append to Triage Log', `${OUTPUT_DIR}/triage-log.jsonl`, 12, Y_MAIN),
    {
      name: '12 Respond with Record',
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1.1,
      position: [X(13), Y_MAIN],
      parameters: {
        respondWith: 'json',
        responseBody: `={{ JSON.stringify(${REF_RECORD}.record) }}`,
        options: { responseCode: 200 },
      },
    },
  ];

  const to = (...names) => names.map((node) => ({ node, type: 'main', index: 0 }));
  const connections = {
    '01 Intake Webhook': { main: [to('02 Normalize Request')] },
    '02 Normalize Request': { main: [to('03 Valid Input?')] },
    '03 Valid Input?': { main: [to('04A Build AI Request'), to('03E Reject Invalid Input')] },
    '04A Build AI Request': { main: [to('04 AI Triage (Groq)')] },
    '04 AI Triage (Groq)': { main: [to('05 Validate AI Output'), to('05E Build Failure Record')] },
    '05 Validate AI Output': { main: [to('06 Determine Destination Queue')] },
    '05E Build Failure Record': { main: [to('06 Determine Destination Queue')] },
    '06 Determine Destination Queue': { main: [to('07 Apply Escalation Rules')] },
    '07 Apply Escalation Rules': { main: [to('08 Build Final Record')] },
    '08 Build Final Record': { main: [to('08B Serialize JSONL Line')] },
    '08B Serialize JSONL Line': { main: [to('09 Escalation Required?')] },
    '09 Escalation Required?': { main: [to('10A Human Review Queue'), to('10B Team Queue')] },
    '10A Human Review Queue': { main: [to('11 Append to Triage Log')] },
    '10B Team Queue': { main: [to('11 Append to Triage Log')] },
    '11 Append to Triage Log': { main: [to('12 Respond with Record')] },
  };

  return {
    name: 'ArcVault AI Triage',
    nodes,
    connections,
    settings: { executionOrder: 'v1' },
    pinData: {},
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Semantic comparison. Ignores what legitimately differs between environments or after an n8n export: node and
// workflow IDs, credential references, canvas positions and sticky-note sizes, timestamps, active/version metadata,
// and the absolute output directory (file names inside it are still compared). Properties n8n adds with an empty
// default value ({} / "" / null / false) are ignored too.
const NODE_KEYS = ['type', 'typeVersion', 'parameters', 'retryOnFail', 'maxTries', 'waitBetweenTries', 'onError'];

function outputDirOf(wf) {
  const log = wf.nodes.find((n) => n.name === '11 Append to Triage Log');
  const f = log?.parameters?.fileName;
  return typeof f === 'string' ? f.replace(/^=/, '').replace(/\/triage-log\.jsonl$/, '') : null;
}

function normalize(wf) {
  const dir = outputDirOf(wf);
  const nodes = {};
  for (const n of wf.nodes) {
    const node = {};
    for (const k of NODE_KEYS) if (n[k] !== undefined) node[k] = JSON.parse(JSON.stringify(n[k]));
    if (n.type === 'n8n-nodes-base.stickyNote') node.parameters = { content: n.parameters.content };
    if (dir && typeof node.parameters?.fileName === 'string') {
      node.parameters.fileName = node.parameters.fileName.split(dir).join(OUTPUT_PLACEHOLDER);
    }
    nodes[n.name] = node;
  }
  return { nodes, connections: wf.connections || {}, executionOrder: wf.settings?.executionOrder };
}

const isEmptyDefault = (v) => v === '' || v === null || v === false ||
  (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);
// Parameters n8n drops from an export when they equal the node's default (defaults read from n8n-nodes-base).
const NODE_DEFAULTS = {
  'n8n-nodes-base.convertToFile': { binaryPropertyName: 'data' },
  'n8n-nodes-base.readWriteFile': { dataPropertyName: 'data' },
};

function describeStringDiff(expected, actual) {
  const e = expected.split('\n');
  const a = actual.split('\n');
  const i = e.findIndex((line, idx) => line !== a[idx]);
  const line = i === -1 ? e.length : i;
  const cut = (s) => (s === undefined ? '<end>' : JSON.stringify(s.length > 70 ? `${s.slice(0, 67)}...` : s));
  return `first difference at line ${line + 1}: expected ${cut(e[line])}, found ${cut(a[line])}`;
}

function diffValues(expected, actual, at, out, defaults = {}) {
  if (typeof expected !== 'object' || expected === null || typeof actual !== 'object' || actual === null) {
    if (expected !== actual) {
      if (typeof expected === 'string' && typeof actual === 'string' && (expected.includes('\n') || actual.includes('\n'))) {
        out.push(`${at}: ${describeStringDiff(expected, actual)}`);
        return;
      }
      const show = (v) => { const s = JSON.stringify(v); return s && s.length > 80 ? `${s.slice(0, 77)}...` : s; };
      out.push(`${at}: expected ${show(expected)}, found ${show(actual)}`);
    }
    return;
  }
  if (Array.isArray(expected) !== Array.isArray(actual)) { out.push(`${at}: type differs`); return; }
  for (const k of Object.keys(expected)) {
    if (!(k in actual)) {
      if (!isEmptyDefault(expected[k]) && defaults[k] !== expected[k]) out.push(`${at}.${k}: missing`);
      continue;
    }
    diffValues(expected[k], actual[k], `${at}.${k}`, out);
  }
  for (const k of Object.keys(actual)) {
    if (!(k in expected) && !isEmptyDefault(actual[k])) out.push(`${at}.${k}: unexpected property`);
  }
}

function compareWorkflows(expectedWf, actualWf) {
  const e = normalize(expectedWf);
  const a = normalize(actualWf);
  const out = [];
  for (const name of Object.keys(e.nodes)) {
    if (!a.nodes[name]) out.push(`node "${name}": missing`);
    else {
      const { parameters: ep, ...eRest } = e.nodes[name];
      const { parameters: ap, ...aRest } = a.nodes[name];
      diffValues(eRest, aRest, `node "${name}"`, out);
      diffValues(ep || {}, ap || {}, `node "${name}".parameters`, out, NODE_DEFAULTS[e.nodes[name].type]);
    }
  }
  for (const name of Object.keys(a.nodes)) if (!e.nodes[name]) out.push(`node "${name}": unexpected node`);
  diffValues(e.connections, a.connections, 'connections', out);
  if (e.executionOrder !== a.executionOrder) out.push(`settings.executionOrder: expected ${e.executionOrder}, found ${a.executionOrder}`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
function main(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv.includes('--check')) {
    const file = path.resolve(arg('--file') || DEFAULT_FILE);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const actual = Array.isArray(parsed) ? parsed[0] : parsed;
    const expected = buildWorkflow({ outputDir: arg('--output-dir') || outputDirOf(actual) || undefined });
    const diffs = compareWorkflows(expected, actual);
    if (diffs.length) {
      console.log(`STALE: ${path.relative(process.cwd(), file)} differs from its sources (${diffs.length} difference(s)):`);
      diffs.slice(0, 20).forEach((d) => console.log(`  - ${d}`));
      console.log('Regenerate with: node scripts/build-workflow.js');
      return 1;
    }
    console.log(`OK: ${path.relative(process.cwd(), file)} is current with workflow/code/ and prompts/.`);
    return 0;
  }
  const workflow = buildWorkflow({ outputDir: arg('--output-dir') });
  const outFile = path.resolve(arg('--file') || DEFAULT_FILE);
  fs.writeFileSync(outFile, JSON.stringify(workflow, null, 2) + '\n');
  console.log(`wrote ${path.relative(process.cwd(), outFile)}: ${workflow.nodes.length} nodes, output dir ${outputDirOf(workflow)}`);
  return 0;
}

module.exports = { buildWorkflow, compareWorkflows, resolveOutputDir, outputDirOf };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
