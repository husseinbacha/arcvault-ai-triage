// Step 5 - Structured output: assemble the final record in the documented schema, plus one JSONL line.
const PROMPT_VERSION = 'triage-v3';
const WORKFLOW_VERSION = '1.1.0';

const req = $('02 Normalize Request').first().json;

const record = {
  request_id: req.request_id,
  received_at: req.received_at,
  source: req.source,
  raw_message: req.raw_message,
  classification: $json.classification,
  enrichment: $json.enrichment,
  routing: $json.routing,
  escalation: $json.escalation,
  summary: $json.summary,
  meta: {
    model: $json.model,
    prompt_version: PROMPT_VERSION,
    workflow_version: WORKFLOW_VERSION,
    processed_at: new Date().toISOString(),
    status: $json.status,
    warnings: $json.warnings,
  },
};

return {
  json: {
    record,
    queue_file: `queue-${record.routing.queue.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.jsonl`,
    jsonl_line: JSON.stringify(record) + '\n',
  },
};
