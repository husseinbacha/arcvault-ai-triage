// Step 1 - Ingestion: turn the raw webhook payload into one normalised request and check it is usable.
const MAX_MESSAGE_CHARS = 5000;
const SOURCES = {
  'email': 'email',
  'web form': 'web_form',
  'web_form': 'web_form',
  'support portal': 'support_portal',
  'support_portal': 'support_portal',
};

const body = $json.body ?? {};
const message = typeof body.message === 'string' ? body.message.trim() : '';
const rawSource = String(body.source ?? '').trim().toLowerCase();

const errors = [];
if (!message) errors.push('message is required and must be a non-empty string');
if (message.length > MAX_MESSAGE_CHARS) errors.push(`message exceeds ${MAX_MESSAGE_CHARS} characters`);

const warnings = [];
const source = SOURCES[rawSource] ?? 'unknown';
if (source === 'unknown') warnings.push(`unrecognised source "${body.source ?? ''}"`);

return {
  json: {
    request_id: `req_${Date.now().toString(36)}_${$execution.id}`,
    received_at: new Date().toISOString(),
    source,
    raw_message: message,
    valid: errors.length === 0,
    input_errors: errors,
    input_warnings: warnings,
  },
};
