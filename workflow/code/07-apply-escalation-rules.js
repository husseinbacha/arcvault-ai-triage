// Step 6 - Escalation: named, deterministic rules evaluated after the AI step (D-05, D-08, D-11).
// Any rule firing sends the record to Human Review INSTEAD of the team queue (D-09).
const CONFIDENCE_THRESHOLD = 0.7;
const BILLING_ERROR_THRESHOLD = 500;
const HUMAN_REVIEW = 'Human Review';
// Raw-text safety net, independent of the LLM. Deliberately narrow: it is a backstop, not the classifier.
const OUTAGE_PATTERN = /\b(outages?|down for (all|every)(one| users?| customers?)|(service|site|platform|app|application|system|arcvault) (is |was |went )?down|not working for (anyone|everyone|all users))\b/i;

const req = $('02 Normalize Request').first().json;
const reasons = [];

if ($json.status !== 'ok') {
  reasons.push({ code: 'AI_FAILURE', detail: `status ${$json.status}: ${$json.errors.join('; ')}` });
} else {
  const { category, confidence } = $json.classification;
  if (confidence < CONFIDENCE_THRESHOLD) {
    reasons.push({ code: 'LOW_CONFIDENCE', detail: `confidence ${confidence} < ${CONFIDENCE_THRESHOLD}` });
  }
  if (category === 'Incident/Outage') {
    reasons.push({ code: 'INCIDENT', detail: 'category is Incident/Outage' });
  }
  const billing = $json.enrichment.billing;
  if (billing) {
    if (billing.discrepancy !== null && billing.discrepancy > BILLING_ERROR_THRESHOLD) {
      reasons.push({ code: 'BILLING_OVER_500', detail: `discrepancy ${billing.discrepancy} > ${BILLING_ERROR_THRESHOLD}` });
    } else if (billing.discrepancy === null && billing.billed_amount !== null && billing.billed_amount > BILLING_ERROR_THRESHOLD) {
      reasons.push({ code: 'BILLING_OVER_500', detail: `only the disputed amount is known (${billing.billed_amount}) and it exceeds ${BILLING_ERROR_THRESHOLD}` });
    }
  }
}

const keywordMatch = req.raw_message.match(OUTAGE_PATTERN);
if (keywordMatch) {
  reasons.push({ code: 'OUTAGE_KEYWORDS', detail: `message contains "${keywordMatch[0]}"` });
}

const required = reasons.length > 0;

return {
  json: {
    ...$json,
    routing: {
      queue: required ? HUMAN_REVIEW : $json.intended_queue,
      intended_queue: $json.intended_queue,
      reason: required ? 'escalated' : 'category_map',
    },
    escalation: { required, reasons },
  },
};
