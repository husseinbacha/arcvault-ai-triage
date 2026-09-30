# Requirements compliance

Each requirement from the assessment brief, with its status, the evidence, and any limitations.
Statuses: **Complete**, **Partial**, **Documented only**, **Not verified**.

| Requirement | Status | Evidence | Notes / limitations |
|-------------|--------|----------|---------------------|
| Step 1: automatic ingestion | Complete | Node `01 Intake Webhook` (`POST /webhook/arcvault/intake`); every live run in `output/` was triggered by an HTTP request, none manually | A real email or form system would POST to this webhook; not connected in the demo |
| Step 2: classification (category, priority, confidence) | Complete | Node `04 AI Triage (Groq)`, validated by `05`; `classification` in [processed-requests.json](../output/processed-requests.json) | Confidence is self-reported and uncalibrated ([prompts.md](../prompts/prompts.md#what-testing-showed-about-confidence)) |
| Step 3: enrichment (core issue, identifiers, urgency) | Complete | `enrichment` in every record; identifier grounding in node `05`; test `ungrounded identifier is removed` | Identifiers must appear literally in the message; normalised forms are not recognised |
| Step 4: routing (at least three queues) | Complete | Node `06`, five queues; queue files `output/queue-*.jsonl`; [architecture-submission.md](architecture-submission.md#3-routing-logic) | Technical Question goes to Technical Support, not IT/Security (documented assumption) |
| Step 4: low-confidence fallback | Complete | `LOW_CONFIDENCE` in node `07`; tests at 0.69/0.70; live: "Hello." at 0.40 and a vague message at 0.55 went to Human Review | Fires on vague text; does not fire on the ambiguous sample 4 (scored 0.95) |
| Step 5: structured JSON record with a 2-3 sentence summary | Complete | Node `08`; [record contract](architecture.md#output-record-contract); checked by `scripts/verify.js` | Summary quality is checked by a filler-phrase warning, not by human rating |
| Step 5: persistent destination | Complete | `output/triage-log.jsonl` (every record) and per-queue JSONL files; `verify.js` checks queue membership | Files stand in for a ticketing system |
| Step 6: human escalation to a separate queue | Complete | Node `07` (5 named rules), node `09` routes to `10A Human Review Queue` instead of the team queue; screenshot [11](../screenshots/11-outage-human-review.png) | Every Incident/Outage escalates by design |
| Five required sample outputs | Complete | [processed-requests.json](../output/processed-requests.json); screenshot [10](../screenshots/10-five-sample-results.png); [verification.md](verification.md) | All 5 match the expected outcomes |
| Prompt documentation | Complete | [prompts/prompts.md](../prompts/prompts.md): active prompt, template, schema, rationale, revision history | One LLM step, so one prompt |
| Architecture write-up (1-2 pages) | Complete | [docs/architecture-submission.md](architecture-submission.md) | Detail in [architecture.md](architecture.md) |
| Model choice stated | Complete | [architecture-submission.md](architecture-submission.md#2-system-design) | |
| Workflow export | Complete | [workflow/arcvault-triage.exported.json](../workflow/arcvault-triage.exported.json), exported from the running instance; semantically identical to the generated file | Output paths are machine-specific; regenerate with one command ([README](../README.md#run-it)) |
| Screenshots of each step with output | Complete | [screenshots/](../screenshots/README.md) | Captured from real executions; credentials not shown |
| Offline tests and verification | Complete | [verification.md](verification.md) | |
| Security review | Complete | [security.md](security.md) | Webhook authentication is documented only (production item) |
| Production-scale design (queueing, backoff, idempotency) | Documented only | [architecture-submission.md](architecture-submission.md#5-what-i-would-do-differently-at-production-scale) | Not built, by design (brief scope) |
| Cross-platform import (macOS / Linux) | Not verified | Generator produces POSIX paths | Only Windows was run |
