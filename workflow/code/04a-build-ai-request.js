// Step 2+3 - Build the single Groq request that does classification + enrichment + summary (D-04).
// SYSTEM_PROMPT and RESPONSE_SCHEMA are embedded by scripts/build-workflow.js from
// prompts/triage-system-prompt.md and prompts/triage-response-schema.json.
const MODEL = 'openai/gpt-oss-120b'; // fallback: 'openai/gpt-oss-20b' (D-03)
const SYSTEM_PROMPT = __SYSTEM_PROMPT__;
const RESPONSE_SCHEMA = __RESPONSE_SCHEMA__;

const userContent = `Source: ${$json.source}\n<customer_message>\n${$json.raw_message}\n</customer_message>`;

return {
  json: {
    groq_body: {
      model: MODEL,
      temperature: 0,
      reasoning_effort: 'low',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'arcvault_triage_v1', strict: true, schema: RESPONSE_SCHEMA },
      },
    },
  },
};
