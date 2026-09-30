# Screenshots

All captured from real executions of the published workflow (n8n 2.41.3, prompt `triage-v3`) or from real test runs.
No credential values appear in any image: node `04 AI Triage (Groq)`, whose panel shows the credential selector, is
deliberately not pictured.

| # | File | What it shows |
|---|------|---------------|
| 01 | [01-workflow-overview.png](01-workflow-overview.png) | The whole workflow, with sticky notes mapping the nodes onto the brief's six steps |
| 02 | [02-intake-and-normalization.png](02-intake-and-normalization.png) | Sample 3: the raw webhook payload (input) and the normalised request (output) of node 02 |
| 03 | [03-input-validation.png](03-input-validation.png) | An empty message takes the `false` branch of node 03 to `03E Reject Invalid Input` (HTTP 400); no AI node runs |
| 04 | [04-ai-request-and-schema.png](04-ai-request-and-schema.png) | Sample 3: node 04A builds the Groq request (model, temperature 0, reasoning low, active system prompt) |
| 05 | [05-ai-output-validation.png](05-ai-output-validation.png) | Sample 3: the raw model response (input) and the validated output of node 05, including the code-computed `discrepancy: 260` |
| 06 | [06-routing-decision.png](06-routing-decision.png) | Sample 3: the category-to-queue table in node 06 and `intended_queue: "Billing"` |
| 07 | [07-escalation-rules.png](07-escalation-rules.png) | Sample 5: node 07 escalates with `INCIDENT`; `routing.queue` is Human Review and `intended_queue` stays Engineering |
| 08 | [08-final-record.png](08-final-record.png) | Sample 3: the final record from node 08 (routing, escalation, summary, meta with `triage-v3`) |
| 09 | [09-queue-and-triage-log.png](09-queue-and-triage-log.png) | Sample 3: node 10B appends the record to `queue-billing.jsonl` (the file name comes from the queue table; Append on) |
| 10 | [10-five-sample-results.png](10-five-sample-results.png) | The five required sample results, printed from `output/processed-requests.json` |
| 11 | [11-outage-human-review.png](11-outage-human-review.png) | Sample 5: node 10A writes the escalated record to `queue-human-review.jsonl` instead of the team queue |
| 12 | [12-offline-tests-21-of-21.png](12-offline-tests-21-of-21.png) | `node scripts/test-code-nodes.js`: 21/21 passed |
| 13 | [13-validation-and-drift-tests.png](13-validation-and-drift-tests.png) | `node scripts/test-validation.js`: 40/40 passed, and `node scripts/build-workflow.js --check`: OK |

Screenshot 04 comes from a later run of sample 3 (execution 65), taken after a comment-only correction to node 04A.
The other n8n screenshots come from the runs recorded in `output/processed-requests.json` (executions 54 and 56) and
from an empty-message probe (execution 64).
