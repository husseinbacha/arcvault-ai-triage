// Fail safe (D-10): the Groq call failed after retries. Produce the same shape as "05 Validate AI Output"
// with no AI fields, so the request still gets a record and goes to Human Review instead of being dropped.
const req = $('02 Normalize Request').first().json;
const reason = $json.error?.message ?? $json.error ?? 'unknown error';

return {
  json: {
    status: 'ai_failed',
    classification: null,
    enrichment: null,
    summary: `Automatic triage failed (${String(reason).slice(0, 200)}). The original message is attached for manual triage.`,
    model: null,
    errors: [`AI request failed: ${String(reason).slice(0, 500)}`],
    warnings: [...req.input_warnings],
  },
};
