# ArcVault AI Triage: architecture write-up

This is the concise architecture brief requested in the assessment. The record contract, node reference and setup
details are in [architecture.md](architecture.md).

## 1. Design in one sentence
**The LLM interprets; code decides.** One LLM call turns an unstructured message into structured facts and a
classification. Everything with business consequences (which queue, whether a human must look) is plain, unit-tested
code that runs after it. Any failure falls back to a human, so no request is ever dropped.

## 2. System design

```
POST /webhook/arcvault/intake {source, message}
  -> 01 Intake Webhook -> 02 Normalize Request -> 03 Valid Input?
       |-- invalid -> 03E Respond 400
       `-- valid -> 04A Build AI Request -> 04 AI Triage (Groq)
                        |-- provider error -> 05E Build Failure Record --.
                        `-- success -> 05 Validate AI Output -----------'
                                            |
                                            v
  06 Determine Queue -> 07 Apply Escalation Rules -> 08 Build Final Record -> 08B Serialize
    -> 09 Escalation Required? -- yes -> 10A Human Review Queue --.
                              `-- no  -> 10B Team Queue -----------'
                                      -> 11 Append to Triage Log -> 12 Respond (record)
```

- **Trigger:** a web form, email bridge or support portal POSTs `{source, message}` to the webhook. The workflow starts
  automatically and returns the final record synchronously.
- **Orchestration:** self-hosted n8n 2.41.3. Small, single-purpose Code nodes are covered by offline tests
  ([verification.md](verification.md)).
- **LLM:** a single HTTP call to Groq's OpenAI-compatible API with a strict JSON schema (see [prompts.md](../prompts/prompts.md)).
  The API key sits in n8n's encrypted credential store, so the exported workflow contains no secret.
- **State:** each request is stateless while processing. Durable state is held in append-only per-queue JSONL files,
  `triage-log.jsonl`, and n8n's execution history. The files stand in for production ticket queues.

**Model choice: Groq `openai/gpt-oss-120b`.** It is available on a free tier, open-weight, fast in testing and supports
strict JSON-schema output. The 20b model also produced valid output as a fallback. Gemini's data-use terms, OpenAI's
cost and the reproducibility/performance of local Ollama made them less suitable for this assessment.

**One call, not three:** classification, enrichment and summary use the same input. One structured call reduces
latency, cost, failure points and cross-call inconsistency.

## 3. Routing logic
Routing is a lookup table in code (`06 Determine Destination Queue`):

| Category | Queue |
|----------|-------|
| Bug Report | Engineering |
| Incident/Outage | Engineering (but always escalated, see below) |
| Feature Request | Product |
| Billing Issue | Billing |
| Technical Question | Technical Support |

Routing is code because it is a business rule: it must be predictable, testable and immune to instructions inside a
customer message. Technical Questions go to customer-facing Technical Support. Each record retains both the actual
queue and `intended_queue`, so a reviewer knows the destination team for an escalated item.

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

The design reflects asymmetric cost: reviewing a false positive is cheaper than missing an outage or large billing
error. Sample 3's discrepancy is $260 ($1,240 minus $980), so it correctly stays in Billing. If only one disputed
amount is known and it exceeds $500, the workflow escalates conservatively.

All five required samples matched their expected outcomes; only the outage escalated. Tests exercise every rule. A
real HTTP 429 also confirmed that provider failures produce an `ai_failed` Human Review record rather than dropping
the request.

## 5. What I would do differently at production scale
- **Reliability.** Enqueue and return `202 Accepted`; process with durable workers. Retry only 429/5xx/timeouts with
  exponential backoff that honours `Retry-After`. Add idempotency keys, model failover and real ticketing queues.
- **Cost.** One call per message keeps cost linear. At volume: a shorter system prompt (it dominates input tokens),
  prompt caching for the fixed prefix, and the 20b model for easy messages if evaluation shows no accuracy loss.
- **Latency.** 1.1-7.2 s end to end, almost all of it the LLM call; asynchronous processing makes this acceptable.
- **Quality and safety.** Monitor category mix and escalation rate for drift, and redact personal data that the prompt
  does not need. Prompt and model versions are already logged per record.

## 6. Phase 2 (one more week)
1. **Evaluation set:** 100-200 labelled messages (including ambiguous, multi-issue and non-English cases), run on
   every prompt or model change with per-category precision and recall.
2. **Meaningful confidence:** calibrate against that set, or use agreement across repeated runs; the current
   self-reported score mainly separates vague from clear messages.
3. **Summaries:** measure summary quality on the evaluation set; add few-shot examples if the v3 rules are not enough.
4. **Reviewer loop:** corrections from Human Review feed back into the evaluation set.
5. **Context:** customer tier from CRM for priority; merge duplicate outage reports into one incident.

## 7. Limitations
Amounts are assumed to be USD. Five samples are too few to claim accuracy. Temperature 0 was not fully deterministic
(sample 1's confidence changed between runs).
