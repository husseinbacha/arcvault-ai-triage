// Step 2+3 - Validate the LLM output semantically. Strict decoding guarantees the JSON shape;
// this checks meaning: enums, ranges, grounding of identifiers, and computes the billing discrepancy (D-08).
const CATEGORIES = ['Bug Report', 'Feature Request', 'Billing Issue', 'Technical Question', 'Incident/Outage'];
const LEVELS = ['Low', 'Medium', 'High'];
const SCOPES = ['single_user', 'single_account', 'multiple_users', 'all_users', 'unknown'];
const IDENTIFIER_KEYS = ['account_ids', 'invoice_numbers', 'error_codes', 'urls', 'other'];
const SUMMARY_FILLER = [
  /\bno (specific |additional )?(identifiers?|billing|account|invoice|error codes?|urgency|amounts?|details)\b[^.]*\b(provided|mentioned|given|included|present|available|stated)\b/i,
  /\b(identifiers?|account (url|id)|billing details|urgency signals?)\b[^.]*\b(is|are|was|were) (not )?(provided|included|mentioned|given|present)\b/i,
  /\b(queue|escalat)/i,
];

const req = $('02 Normalize Request').first().json;
const choice = $json.choices?.[0] ?? {};
const errors = [];
const warnings = [...req.input_warnings];

let ai = null;
try {
  ai = JSON.parse(choice.message?.content ?? '');
} catch (e) {
  errors.push('AI response content is not valid JSON');
}
if (choice.finish_reason && choice.finish_reason !== 'stop') errors.push(`finish_reason is "${choice.finish_reason}"`);

const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
if (errors.length === 0 && (ai === null || typeof ai !== 'object' || Array.isArray(ai))) {
  errors.push('AI response is not a JSON object');
  ai = null;
}

if (ai) {
  if (!CATEGORIES.includes(ai.category)) errors.push(`invalid category "${ai.category}"`);
  if (!LEVELS.includes(ai.priority)) errors.push(`invalid priority "${ai.priority}"`);
  if (!LEVELS.includes(ai.urgency_level)) errors.push(`invalid urgency_level "${ai.urgency_level}"`);
  if (!SCOPES.includes(ai.affected_scope)) errors.push(`invalid affected_scope "${ai.affected_scope}"`);
  if (typeof ai.confidence !== 'number' || ai.confidence < 0 || ai.confidence > 1) errors.push(`confidence out of range: ${ai.confidence}`);
  for (const field of ['core_issue', 'summary', 'category_rationale']) {
    if (typeof ai[field] !== 'string' || !ai[field].trim()) errors.push(`${field} is empty`);
  }
  if (!ai.identifiers || typeof ai.identifiers !== 'object' || !IDENTIFIER_KEYS.every((k) => isStringArray(ai.identifiers[k]))) {
    errors.push('identifiers must be an object of string arrays');
  }
  if (!isStringArray(ai.urgency_signals)) errors.push('urgency_signals must be an array of strings');
  if (!ai.billing || typeof ai.billing !== 'object') errors.push('billing must be an object');
}

let classification = null;
let enrichment = null;
let summary = null;

if (ai && errors.length === 0) {
  // Grounding check: keep only identifiers that literally appear in the message.
  const haystack = req.raw_message.toLowerCase();
  const identifiers = {};
  for (const key of IDENTIFIER_KEYS) {
    identifiers[key] = [];
    for (const value of ai.identifiers[key]) {
      if (value.trim() && haystack.includes(value.trim().toLowerCase())) {
        identifiers[key].push(value.trim());
      } else {
        warnings.push(`dropped ungrounded identifier ${key}="${value}"`);
      }
    }
  }

  // Billing: only kept for Billing Issue. The LLM extracts amounts; code computes the discrepancy.
  let billing = null;
  if (ai.category === 'Billing Issue') {
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const billed = num(ai.billing?.billed_amount);
    const expected = num(ai.billing?.expected_amount);
    billing = {
      billed_amount: billed,
      expected_amount: expected,
      currency: ai.billing?.currency ?? null,
      discrepancy: billed !== null && expected !== null ? Math.round(Math.abs(billed - expected) * 100) / 100 : null,
    };
  }

  const sentences = ai.summary.split(/[.!?](?:\s|$)/).filter((s) => s.trim()).length;
  if (sentences < 2 || sentences > 3) warnings.push(`summary has ${sentences} sentence(s), expected 2-3`);
  // Summary quality: flag sentences that describe absent or schema fields instead of the customer's request.
  const filler = SUMMARY_FILLER.find((re) => re.test(ai.summary));
  if (filler) warnings.push(`summary contains filler matching ${filler}`);

  classification = {
    category: ai.category,
    priority: ai.priority,
    confidence: ai.confidence,
    rationale: ai.category_rationale,
  };
  enrichment = {
    core_issue: ai.core_issue,
    identifiers,
    urgency: { level: ai.urgency_level, signals: ai.urgency_signals },
    affected_scope: ai.affected_scope,
    billing,
  };
  summary = ai.summary;
}

return {
  json: {
    status: errors.length === 0 ? 'ok' : 'validation_failed',
    classification,
    enrichment,
    summary,
    model: $json.model ?? null,
    errors,
    warnings,
  },
};
