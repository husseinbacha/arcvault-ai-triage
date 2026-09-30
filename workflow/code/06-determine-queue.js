// Step 4 - Routing: map the category to the team queue. Plain config, no LLM involved (D-05).
const QUEUE_BY_CATEGORY = {
  'Bug Report': 'Engineering',
  'Incident/Outage': 'Engineering', // always escalated by rule INCIDENT, so it lands in Human Review
  'Feature Request': 'Product',
  'Billing Issue': 'Billing',
  'Technical Question': 'Technical Support',
};

const category = $json.classification?.category;
const intendedQueue = $json.status === 'ok' ? QUEUE_BY_CATEGORY[category] ?? null : null;

return {
  json: {
    ...$json,
    intended_queue: intendedQueue,
  },
};
