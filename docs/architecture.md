# Technical reference

Implementation detail behind the [architecture write-up](architecture-submission.md): the output record contract,
what each n8n node does, and how the workflow is configured.

## Output record contract
Every processed request produces one record with this shape. The HTTP response, the queue files and
`output/triage-log.jsonl` all hold this same record. `scripts/verify.js` checks every committed record against these rules.

```json
{
  "request_id": "req_<time36>_<n8n execution id>",
  "received_at": "ISO-8601 UTC",
  "source": "email | web_form | support_portal | unknown",
  "raw_message": "the customer text, trimmed",
  "classification": {
    "category": "Bug Report | Feature Request | Billing Issue | Technical Question | Incident/Outage",
    "priority": "Low | Medium | High",
    "confidence": 0.0,
    "rationale": "one sentence citing the evidence"
  },
  "enrichment": {
    "core_issue": "one sentence",
    "identifiers": { "account_ids": [], "invoice_numbers": [], "error_codes": [], "urls": [], "other": [] },
    "urgency": { "level": "Low | Medium | High", "signals": ["verbatim phrases from the message"] },
    "affected_scope": "single_user | single_account | multiple_users | all_users | unknown",
    "billing": { "billed_amount": 0, "expected_amount": 0, "currency": "USD", "discrepancy": 0 }
  },
  "routing": { "queue": "actual destination", "intended_queue": "team queue", "reason": "category_map | escalated" },
  "escalation": { "required": false, "reasons": [{ "code": "RULE_CODE", "detail": "human-readable reason" }] },
  "summary": "2-3 sentences for the receiving team",
  "meta": {
    "model": "openai/gpt-oss-120b",
    "prompt_version": "triage-v3",
    "workflow_version": "1.1.0",
    "processed_at": "ISO-8601 UTC",
    "status": "ok | ai_failed | validation_failed",
    "warnings": []
  }
}
```

Rules:
- `routing.queue` is always where the record went. `intended_queue` is the team queue the category maps to (null on AI failure).
- `escalation.required` is true exactly when `routing.queue` is `Human Review`.
- `billing` is null unless the category is Billing Issue. `discrepancy` is computed in code, never by the model.
- Every identifier appears literally in `raw_message` (case-insensitive); anything else is dropped with a warning.
- When `meta.status` is not `ok`, `classification` and `enrichment` are null and the escalation reasons include `AI_FAILURE`.

## Node reference
| Node | Type | Responsibility |
|------|------|----------------|
| 01 Intake Webhook | Webhook | `POST /webhook/arcvault/intake`; replies through a Respond node |
| 02 Normalize Request | Code | request ID and timestamp, source mapping, trimming; rejects empty, non-string or over-5,000-character messages |
| 03 Valid Input? / 03E Reject Invalid Input | IF / Respond | invalid input gets HTTP 400 before any LLM call |
| 04A Build AI Request | Code | assembles model, parameters, system prompt, fenced user message and strict schema |
| 04 AI Triage (Groq) | HTTP Request | one call; 3 tries, 2 s apart, 30 s timeout; the error output leads to 05E |
| 05 Validate AI Output | Code | JSON and shape checks, enums, ranges, identifier grounding, billing discrepancy, summary warnings |
| 05E Build Failure Record | Code | provider failure produces a record with status `ai_failed` (same shape, no AI fields) |
| 06 Determine Destination Queue | Code | category-to-queue table |
| 07 Apply Escalation Rules | Code | `LOW_CONFIDENCE`, `INCIDENT`, `OUTAGE_KEYWORDS`, `BILLING_OVER_500`, `AI_FAILURE`; sets the final queue |
| 08 Build Final Record / 08B Serialize | Code / Convert to File | final record plus one JSONL line; queue file name from the fixed queue table |
| 09 Escalation Required? | IF | Human Review or team queue, never both |
| 10A / 10B | Read/Write File | append to `queue-human-review.jsonl` or `queue-<team>.jsonl` |
| 11 Append to Triage Log | Read/Write File | append every record to `triage-log.jsonl` |
| 12 Respond with Record | Respond | returns the final record with HTTP 200 |

The Code node sources are in [`workflow/code/`](../workflow/code/); the workflow file is generated from them.

## Configuration
| Setting | Where | Default |
|---------|-------|---------|
| Output directory | `node scripts/build-workflow.js --output-dir <dir>` or `ARCVAULT_OUTPUT_DIR` | `<repo>/output` |
| n8n file-access restriction | `start-n8n.ps1` sets `N8N_RESTRICT_FILE_ACCESS_TO` with the same rule | `<repo>/output` |
| Groq API key | n8n Header Auth credential named `Groq API` (`Authorization: Bearer ...`) | none; never stored in the repository |
| Model and parameters | `workflow/code/04a-build-ai-request.js` | `openai/gpt-oss-120b`, temperature 0, reasoning low |
| Thresholds | `workflow/code/07-apply-escalation-rules.js` | confidence 0.70, billing error $500 |
| Network binding and mode | `start-n8n.ps1` | `N8N_LISTEN_ADDRESS=127.0.0.1`, `NODE_ENV=production`, `GENERIC_TIMEZONE=UTC` |

n8n's file nodes need absolute paths, so the output directory is written into the generated workflow at build time.
Regenerating for another checkout is one command, and `--check` confirms the result matches the sources.
