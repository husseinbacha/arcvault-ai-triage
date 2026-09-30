# Verification report

What was checked, how, and the exact result. Everything under "Offline checks" can be re-run from a fresh clone
with Node.js alone (no n8n, no API key, no network).

## Offline checks (reproducible)

| Check | Command | Result |
|-------|---------|--------|
| Original Code-node unit tests | `node scripts/test-code-nodes.js` | **21/21 passed** |
| Deterministic validation suite | `node scripts/test-validation.js` | **40/40 passed** |
| Generated-workflow drift check | `node scripts/build-workflow.js --check` | **OK**: workflow is current with `workflow/code/` and `prompts/` |
| Repository consistency | `node scripts/verify.js` | **All checks passed** (list below) |
| JavaScript syntax | `node --check` on every `.js` file | all pass |
| PowerShell syntax | PowerShell language parser on every `.ps1` file | all pass |

`scripts/verify.js` checks:
- every JSON and JSONL file parses;
- the response schema is strict-mode compatible;
- `prompts.md` reproduces the active prompt exactly;
- every committed output record matches the [record contract](architecture.md#output-record-contract), and identifiers are grounded;
- the five required samples have the expected outcomes;
- every triage-log record is in exactly one queue file, the one matching its `routing.queue`;
- both the generated and the exported workflow contain exactly the Code-node sources, the active prompt and the schema;
- the generated and exported workflows are semantically identical;
- a secret-pattern scan of all files finds nothing;
- relative Markdown links resolve.

Screenshots: [12 - original suite](../screenshots/12-offline-tests-21-of-21.png),
[13 - validation suite and drift check](../screenshots/13-validation-and-drift-tests.png).

`test-validation.js` covers:
- input validation: missing body or message, a non-string message, whitespace only, and the 5,000/5,001-character boundary;
- malformed model output: invalid enums, confidence out of range, non-finite amounts, wrongly typed identifier lists,
  malformed JSON, `null` content, a missing choice, message or content, and a truncated `finish_reason`;
- fail-safe routing for validation and provider failures;
- threshold boundaries (0.69/0.70, $500.00/$500.01) and sample 3's $260 case;
- the incident rule without the word "outage", and the keyword override;
- safe queue file names, provenance fields and drift detection.

## Live checks (n8n 2.41.3 + Groq `openai/gpt-oss-120b`, prompt `triage-v3`, workflow 1.1.0)

**Five required samples**: [`output/processed-requests.json`](../output/processed-requests.json), screenshot
[10](../screenshots/10-five-sample-results.png)

| # | Category | Priority | Conf. | Queue | Intended | Escalated | Expected | Match |
|---|----------|----------|-------|-------|----------|-----------|----------|-------|
| 1 | Bug Report | Medium | 0.93 | Engineering | Engineering | no | Bug Report / Medium / Engineering / no | yes |
| 2 | Feature Request | Low | 0.95 | Product | Product | no | Feature Request / Low / Product / no | yes |
| 3 | Billing Issue | Medium | 0.95 | Billing | Billing | no ($260 discrepancy) | Billing Issue / Medium / Billing / no | yes |
| 4 | Technical Question | Low | 0.95 | Technical Support | Technical Support | no | Technical Question / Low / Technical Support / no | yes |
| 5 | Incident/Outage | High | 0.95 | Human Review | Engineering | yes (`INCIDENT`) | Incident/Outage / High / Human Review / yes | yes |

None of the five v3 summaries contains filler, and the validator raised no warnings. The same five classifications
were produced by prompts v1 and v2, so the v3 summary change did not alter classification or routing.

**Summary-quality set (v3)**: [`output/summary-eval-results.json`](../output/summary-eval-results.json)

Six new messages, varied by category, with expected queues written before the run. All 6 routed as expected
(Engineering, Product, Billing, Technical Support, Human Review via `INCIDENT`, and Human Review via `LOW_CONFIDENCE` for
"Hello." at 0.40). The validator flagged filler in none of them. For "Hello." the summary says no details were given;
that is intended, because the missing information itself blocks action.

**Earlier live runs (prompt v2, same routing and escalation code)**
- Edge cases, [`output/edge-case-results.json`](../output/edge-case-results.json):
  - all-users outage: `INCIDENT` + `OUTAGE_KEYWORDS`;
  - $2,150 vs $1,500: `BILLING_OVER_500`;
  - empty message: HTTP 400, no LLM call.
- Extra cases, [`output/extra-case-results.json`](../output/extra-case-results.json): 7/7 as expected, including a
  vague message (0.55, `LOW_CONFIDENCE`) and a prompt-injection attempt (routed normally).
- Provider failure, [`output/evidence-rate-limit-failsafe.json`](../output/evidence-rate-limit-failsafe.json): real
  Groq HTTP 429 responses. Both records became `ai_failed` and went to Human Review; the outage message was still
  escalated by `OUTAGE_KEYWORDS`.
- Security suite, [`output/security-test-results.json`](../output/security-test-results.json): 12/12 (see
  [security.md](security.md)).

**Workflow export**: `workflow/arcvault-triage.exported.json` was exported from the running instance after the v3
import. `verify.js` confirms it is semantically identical to the generated workflow.

## Secret scan
- Current files: 6 patterns (Groq, OpenAI-style, AWS and GitHub tokens, private-key blocks, literal bearer tokens),
  0 matches. Values are never printed.
- Git history: every commit was scanned with the same patterns, 0 matches.
- The Groq key exists only in n8n's encrypted credential store. The exported workflow references the credential
  by name only.

## Not verified
- The workflow was run on Windows only. Building from another directory and with a different output directory was
  verified. An import on macOS or Linux was not run, although the generator produces POSIX paths there.
- Accuracy beyond these messages is not claimed. The samples and extra cases are too few for an accuracy estimate.
