# ArcVault AI Triage

An n8n workflow that takes an unstructured customer message (email, web form or support portal) and does the
following:
1. classifies and enriches it with **one** LLM call (Groq, `openai/gpt-oss-120b`, strict JSON schema);
2. validates the model's output in code;
3. routes the message to a team queue with deterministic rules;
4. sends risky or uncertain cases to a separate **Human Review** queue instead;
5. stores one structured JSON record per request.

Built for the Valsoft AI Engineer technical assessment.

## Assessment Deliverables

- **Importable n8n workflow:** [`workflow/arcvault-triage.exported.json`](workflow/arcvault-triage.exported.json) (exported from the running instance; only the instance-specific owner field `shared` was removed) and [`workflow/arcvault-triage.json`](workflow/arcvault-triage.json) (generated from source)
- **Five required output records:** [`output/processed-requests.json`](output/processed-requests.json)
- **Workflow screenshots:** [`screenshots/`](screenshots/README.md)
- **Prompt documentation:** [`prompts/prompts.md`](prompts/prompts.md)
- **Architecture submission:** [`docs/architecture-submission.md`](docs/architecture-submission.md) (1-2 pages), with detail in [`docs/architecture.md`](docs/architecture.md)
- **Security review:** [`docs/security.md`](docs/security.md)
- **Offline tests:** `scripts/test-code-nodes.js`, `scripts/test-validation.js`, `scripts/verify.js`; results in [`docs/verification.md`](docs/verification.md)
- **Decision and test log:** [`NOTES.md`](NOTES.md)
- **Requirements compliance matrix:** [`docs/compliance.md`](docs/compliance.md)
- **Setup instructions:** [below](#run-it)

## How it works

```
Webhook -> normalise + validate input -> one strict-JSON LLM call -> validate output in code
        -> category -> queue -> escalation rules -> final record -> queue file + triage log -> HTTP response
```

- **The LLM interprets; code decides.** The model returns facts and a classification. Queues, escalation and the
  billing discrepancy are plain, unit-tested code, so a customer message cannot talk its way into a different queue.
- **Five queues:** Engineering, Product, Billing, Technical Support, and Human Review.
- **Five escalation rules:**
  - `LOW_CONFIDENCE`: confidence below 0.70;
  - `INCIDENT`: the category is Incident/Outage;
  - `OUTAGE_KEYWORDS`: the raw text contains outage wording (works even if the LLM fails);
  - `BILLING_OVER_500`: the billing error, computed in code, is over $500;
  - `AI_FAILURE`: the provider failed or the model's output was invalid.
- **Nothing is dropped:** provider errors and invalid model output still produce a record, which goes to Human Review.
- **Model:** Groq `openai/gpt-oss-120b`. It is free-tier, fast and open-weight, with strict schema support. The reasons,
  and the alternatives considered, are in the [architecture submission](docs/architecture-submission.md).

## Results for the five samples

| # | Source | Category | Priority | Conf. | Queue (intended) | Escalated |
|---|--------|----------|----------|-------|------------------|-----------|
| 1 | Email | Bug Report | Medium | 0.93 | Engineering | No |
| 2 | Web Form | Feature Request | Low | 0.95 | Product | No |
| 3 | Support Portal | Billing Issue | Medium | 0.95 | Billing | No (error $260, not > $500) |
| 4 | Email | Technical Question | Low | 0.95 | Technical Support | No |
| 5 | Web Form | Incident/Outage | High | 0.95 | **Human Review** (Engineering) | Yes: `INCIDENT` |

These were produced live by prompt `triage-v3`. Each record also carries the extracted identifiers, the urgency
signals, the billing amounts (sample 3: 1240 vs 980, discrepancy 260) and a 2-3 sentence summary.

## Run it

**Requirements:** Node.js >= 24, n8n 2.41.3 (`npm install -g n8n@2.41.3`), and a free Groq API key.

1. **Build the workflow for your checkout** (writes absolute output paths for this folder):
   ```
   node scripts/build-workflow.js
   ```
   Add `--output-dir <absolute path>`, or set `ARCVAULT_OUTPUT_DIR`, to write somewhere else. n8n's file nodes need
   absolute paths, so the directory is baked in at build time. Output file names come from a fixed queue table,
   never from request data.
2. **Start n8n:** `.\start-n8n.ps1` on Windows. It allows file access only to the same output directory, binds to
   127.0.0.1, sets UTC and runs in production mode. On macOS or Linux, set `N8N_RESTRICT_FILE_ACCESS_TO` to the
   output directory and run `n8n start`.
3. **Add the credential (the key stays in n8n, never in files):** in n8n, create a **Header Auth** credential named
   `Groq API`, with Name `Authorization` and Value `Bearer <your Groq key>`.
4. **Import** `workflow/arcvault-triage.json`. Open node `04 AI Triage (Groq)` and select the `Groq API` credential.
   Save, then **Publish**. The exported file imports the same way, but its output paths point at the original
   machine, so use the generated file on a new machine.
5. **Send the samples:** `.\scripts\run-tests.ps1 -DelaySeconds 12`. Results are saved to `output/processed-requests.json`.
   The delay keeps you under Groq's free-tier rate limit. Other test sets are in `test-data/`
   (`-InputFile test-data\edge-cases.json -OutFile output\edge-case-results.json`), and hostile-input tests run with
   `.\scripts\security-tests.ps1`.

Send one message by hand:
```powershell
$body = @{ source = 'email'; message = 'Could you add a dark mode?' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:5678/webhook/arcvault/intake -ContentType 'application/json' -Body $body
```

**Offline checks** (no n8n, no key, no network):
```
node scripts/test-code-nodes.js        # 21 Code-node unit tests
node scripts/test-validation.js        # 40 validation, routing, escalation and drift tests
node scripts/build-workflow.js --check # the workflow matches its sources
node scripts/verify.js                 # records, prompt embedding, queue membership, secret scan, links
```

## What was verified
- **Offline:** 21/21 and 40/40 tests, drift check OK, and every `verify.js` check passes. See [docs/verification.md](docs/verification.md).
- **Live (n8n 2.41.3 + Groq, prompt v3):**
  - the 5 samples, plus a 6-message summary-quality set;
  - under the previous prompt with the same routing code: edge cases, 7 extra cases, a real Groq rate-limit failure
    handled by the fail-safe, and a 12-check security suite.

## Known limitations
- Confidence is self-reported and coarse: the ambiguous sample 4 scored 0.95. It catches vague messages, not ambiguous
  categories.
- Temperature 0 is not fully deterministic on Groq (sample 1 scored 0.95, 0.85 and 0.93 across runs).
- The free tier rate-limits bursts. The fail-safe handles it, but production needs a queue with backoff.
- The webhook has no authentication, which is acceptable for a localhost demo. A production design is in [docs/security.md](docs/security.md).
- A handful of test messages is not an accuracy estimate. A labelled evaluation set is the first Phase 2 item.

## Repository layout
```
workflow/    exported and generated n8n workflow; code/ holds the Code-node sources
prompts/     prompts.md, active system prompt, response schema; archive/ holds inactive versions
docs/        architecture submission, technical reference, security, verification, compliance
scripts/     workflow generator, offline tests, verifier, live test runners
test-data/   the five samples (verbatim), edge cases, extra cases, summary-quality set
output/      records, queue files, triage log, test results
screenshots/ workflow executions and test runs
```
