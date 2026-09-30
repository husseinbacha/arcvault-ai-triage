# ArcVault AI Triage: architecture write-up

The one-to-two-page write-up the brief asks for. Implementation detail (record contract, node reference, configuration) is in [architecture.md](architecture.md).

## 1. Design in one sentence
**The LLM interprets; code decides.** One LLM call turns an unstructured message into structured facts and a
classification. Everything with business consequences (which queue, whether a human must look) is plain, unit-tested
code that runs after it. Any failure falls back to a human, so no request is ever dropped.

## 2. System design

```
POST /webhook/arcvault/intake {source, message}
  01 Intake Webhook â”€â–¶ 02 Normalize Request â”€â–¶ 03 Valid Input? â”€â”€falseâ”€â”€â–¶ 03E Respond 400
                                                     â”‚ true
  04A Build AI Request â”€â–¶ 04 AI Triage (Groq, 3 tries) â”€â”€errorâ”€â”€â–¶ 05E Build Failure Record â”€â”
                                   â”‚ success                                                  â”‚
                          05 Validate AI Output â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¤
                                                                                              â–¼
  06 Determine Destination Queue â”€â–¶ 07 Apply Escalation Rules â”€â–¶ 08 Build Final Record â”€â–¶ 08B Serialize
  â”€â–¶ 09 Escalation Required? â”€â”€trueâ”€â”€â–¶ 10A Human Review Queue â”€â”
                             â””â”€falseâ”€â–¶ 10B Team Queue â”€â”€â”€â”€â”€â”€â”€â”€â”€â”´â”€â–¶ 11 Append to Triage Log â”€â–¶ 12 Respond (record)
```

- **Trigger:** an HTTP webhook. Any sender (web form, email-to-webhook bridge, support portal) POSTs
  `{source, message}` and the workflow starts automatically. The sender gets the final record back synchronously.
- **Orchestration:** n8n 2.41.3, self-hosted. Sticky notes map nodes onto the brief's six steps. Small Code nodes,
  one job each, covered by offline test suites (see [verification.md](verification.md)).
- **LLM:** a single HTTP call to Groq's OpenAI-compatible API with a strict JSON schema (see [prompts.md](../prompts/prompts.md)).
  The API key sits in n8n's encrypted credential store, so the exported workflow contains no secret.
- **Where state is held:** the workflow itself is stateless per request. Durable state is (a) append-only JSONL files
  in `output/`: one file per queue (`queue-billing.jsonl`, `queue-human-review.jsonl`, ...) plus `triage-log.jsonl`
  with every record, and (b) n8n's own execution history (SQLite in `~/.n8n`), which stores each node's input and output
  for debugging and audit. There is no database; queue files stand in for real ticket queues.

**Model choice (D5): Groq `openai/gpt-oss-120b`.** Reasons: it is free on Groq's free tier (the brief asks for free or
low-cost); it is an open-weight model, so the same model can later be self-hosted for data-privacy reasons; Groq
supports strict JSON-schema output, which removes malformed-JSON handling; and calls took about 0.75 s in isolation.
`openai/gpt-oss-20b` was tested as a drop-in fallback (same provider, same schema, valid output). Rejected: Gemini's free tier
(free-tier prompts may be used to improve Google's products, a poor fit for customer data), OpenAI (not free), and
local Ollama (slower and weaker on a laptop, and an evaluator could not reproduce results).

**One call, not three:** splitting classification, enrichment and summary would triple latency, cost and failure
points, and let the summary contradict the category. There is no AI Agent node, because there are no tools to choose
between.

## 3. Routing logic
Routing is a lookup table in code (`06 Determine Destination Queue`):

| Category | Queue |
|----------|-------|
| Bug Report | Engineering |
| Incident/Outage | Engineering (but always escalated, see below) |
| Feature Request | Product |
| Billing Issue | Billing |
| Technical Question | Technical Support |

Why code rather than asking the LLM for a queue: routing is a business rule. It should be predictable, testable and
changeable (for example, adding a queue) without touching the prompt, and it must not be steerable by text inside a
customer message. Technical Question goes to customer-facing Technical Support rather than IT/Security. That is
arguable for the SSO question (sample 4) and is documented as an assumption. The record keeps both
`routing.queue` (where it actually went) and `routing.intended_queue` (the team queue), so a reviewer can forward an
escalated item without re-triaging it.

## 4. Escalation logic
Node `07 Apply Escalation Rules` evaluates five named rules. If **any** fires, the record goes to the Human Review
queue **instead of** the team queue, and the record lists every rule that fired with a human-readable detail.

| Rule | Fires when | Why |
|------|-----------|-----|
| `LOW_CONFIDENCE` | confidence < 0.70 | The brief's threshold; the fallback for uncertain classifications |
| `INCIDENT` | category = Incident/Outage | Sample 5 is a real outage that never uses the word "outage", so a keyword rule alone would miss it |
| `OUTAGE_KEYWORDS` | the raw text says "outage", "down for all/everyone", "<service> is down", ... | A safety net that does not depend on the LLM at all |
| `BILLING_OVER_500` | \|billed - expected\| > $500, computed in code | "Billing error" = the amount that is wrong, not the invoice total |
| `AI_FAILURE` | Groq error after retries, or output failing validation | Fail safe: a human triages it instead of the request being lost |

The design principle is **asymmetric cost**: a false escalation costs a reviewer a minute, while a missed outage or a large
billing error costs far more. Two interpretation choices: sample 3 ($1,240 billed vs $980 contract) is a $260
error, so it is **not** escalated and goes to Billing; and if only one disputed amount is known and it exceeds $500,
the rule escalates conservatively.

**Evidence.** All 5 samples matched the expected outcomes written before the first run; only sample 5 escalated. Every rule was
triggered by at least one test case (see [verification.md](verification.md)). An unplanned test came from Groq's free tier rate-limiting a burst
of requests (HTTP 429): both affected records became `ai_failed` and went to Human Review, and the keyword rule still
escalated the outage message with no AI output at all.

## 5. What I would do differently at production scale
- **Reliability.** The webhook should enqueue and return `202 Accepted`, with workers processing the queue, so LLM
  latency and 429s never reach senders. Retry only 429/5xx/timeouts with backoff that honours `Retry-After` (today:
  any error, 3 tries 2 s apart, which proved too short). Add idempotency keys against duplicate tickets, failover to the
  fallback model, and real ticketing queues (Jira, Zendesk) instead of JSONL files.
- **Cost.** One call per message keeps cost linear. At volume: a shorter system prompt (it dominates input tokens),
  prompt caching for the fixed prefix, and the 20b model for easy messages if evaluation shows no accuracy loss.
- **Latency.** 1.1-7.2 s end to end, almost all of it the LLM call; asynchronous processing makes this acceptable.
- **Quality and safety.** Monitor category mix and escalation rate for drift, and redact personal data that the prompt
  does not need. Prompt and model versions are already logged per record.

## 6. Phase 2 (one more week)
1. **Evaluation set:** 100-200 labelled messages (ambiguous, multi-issue, non-English) with per-category precision and
   recall, run on every prompt or model change.
2. **Meaningful confidence:** calibrate against that set, or use agreement across repeated runs. Today 6 of 7 AI
   records scored 0.95, so the 0.70 threshold only catches very vague text.
3. **Summaries:** measure summary quality on the evaluation set; add few-shot examples if the v3 rules are not enough.
4. **Reviewer loop:** corrections from Human Review feed back into the evaluation set.
5. **Context:** customer tier from CRM for priority; merge duplicate outage reports into one incident.

## 7. Limitations
Amounts are assumed to be USD. Five samples are too few to claim accuracy. Temperature 0 was not fully deterministic
(sample 1's confidence changed between runs).
