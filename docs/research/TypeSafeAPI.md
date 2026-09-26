# TypeSafe Jev System One API: primary-source contract (researched 2026-09-26)

> Sources: docs.typesafe.ai (Mintlify `.md` pages), `https://api.typesafe.ai/openapi.json`, GitHub `typesafe-ai/typesafe-sdk-js@main` (v0.6.0), `typesafe-ai/typesafe-sdk-python@main` (v0.7.1), `typesafe-ai/system-one-adapter-python`, `typesafe-ai/skills`, and the typesafe.ai launch blog. Read-only subagent: this file could not be written to `local://research/TypeSafeAPI.md` by me; the parent agent should persist this text. `[INFERENCE]` marks anything not directly observed.

---

## 1. Endpoint, auth and transport

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <API_KEY>
Content-Type: application/json
```
Source: https://docs.typesafe.ai/api.md

- Model list: `GET https://api.typesafe.ai/v1/models` returns `{"models":[{"name","description","release_date"}]}`. It currently lists only aliases; versioned IDs are accepted even though they aren't listed (https://docs.typesafe.ai/models.md).
- OpenAPI: `https://api.typesafe.ai/openapi.json` (OpenAPI 3.1.0, `info.version: "0.2.0"`). Human docs are at `https://api.typesafe.ai/docs/`.
- Security scheme: `HTTPBearer`.
- Request-ID response header: `x-typesafe-request-id` (both SDKs: `REQUEST_ID_HEADER`).
- Headers the SDKs send: `Authorization: Bearer …`, `Accept: application/json`, `Content-Type: application/json`, `User-Agent: typesafe-sdk/<ver>`, `X-TypeSafe-SDK: typesafe-sdk/<ver>`, `X-TypeSafe-Runtime: <runtime>`, and `X-TypeSafe-Retry-Count: <n>` on retries only (JS `src/client.ts` `fetchWithRetries`; Python `_core/constants.py`, `_core/transport.py`).
- No streaming (LiteLLM docs: "Not offered by the TypeSafe API").
- **EU base URL: none exists in any primary source.** The SDK default is `https://api.typesafe.ai` only. The launch blog says "our service is currently based on the West Coast" (https://typesafe.ai/blog/introducing-system-one-models-and-jev). Zero data retention (ZDR) is offered for enterprise customers (https://docs.typesafe.ai/legal.md). Alternative routes documented by TypeSafe are gateways: OpenRouter (`base_url="https://openrouter.ai/api"`, `model="~typesafe/jev-latest"`) and Vercel AI Gateway (`base_url="https://ai-gateway.vercel.sh/typesafe"`, `model="typesafe-ai/jev"`) (https://docs.typesafe.ai/sdk/python/usage.md). `[INFERENCE]` From Korea, expect an extra trans-Pacific round trip on top of model latency.

## 2. Request body (exact)

Top level (OpenAPI `SystemOneRequest`, required `["model","questions","state"]`):

| field | type | notes |
|---|---|---|
| `state` | `string \| object \| array` (**not null** server-side) | content evaluated by every question |
| `model` | `string` | `"jev-latest"`, `"jev-preview"`, or a versioned ID such as `"jev-1.13.0"` |
| `questions` | `map<string, Question>` with `minProperties: 1` | keys are your IDs and are **not sent to the model** |

Question union (discriminator `type`):

| type | `instructions` | `criteria` | server-required |
|---|---|---|---|
| `noul` | string/object/array/null (optional in schema; docs call it required) | optional `{ "true": EntryType, "false": EntryType }` | `["type"]` |
| `choice` | string/object/array/null | **map** `option → string/object/array/null`; **max 255 options** (docs) | `["criteria","type"]` |
| `score` | string/object/array/null | **ordered array** of string/object/array (**null not allowed** in OpenAPI), `minItems:1`; docs say at least 2 should be used, **API accepts up to 10** | `["criteria","type"]` |

Criteria format pitfalls (dict vs list):
- Choice uses a dict. The JS `choice()` throws `"Choice criteria must be a map of labels to descriptions, not a list."`
- Score uses a list. JS `score()`/`validateQuestions` throws if it isn't an array or has fewer than 2 entries. Python rejects an empty list.
- Before SDK v0.6.0 (2026-09-15) Score criteria was a **dict keyed by integers**, so third-party snippets using that form are stale (JS and Python changelogs).

Example, copied from https://docs.typesafe.ai/introduction/quickstart.md:
```json
{
  "state": "Hi, I've been trying to connect my Stripe account for 3 days and the integration keeps failing. I'm losing sales. Please help ASAP.",
  "model": "jev-latest",
  "questions": {
    "department": {
      "type": "choice",
      "instructions": "Which team should handle this",
      "criteria": {
        "billing": "Payment or subscription issues",
        "technical": "Bugs or integration problems",
        "sales": "Pricing or account questions"
      }
    },
    "frustration": {
      "type": "score",
      "instructions": "How frustrated the customer appears",
      "criteria": [
        "Calm, just stating facts",
        "Frustrated but civil",
        "Very angry, strong language"
      ]
    },
    "is_urgent": {
      "type": "noul",
      "instructions": "The message conveys urgency or time-sensitivity"
    }
  }
}
```

Noul with criteria, copied from https://docs.typesafe.ai/api.md:
```json
"is_urgent": {
  "type": "noul",
  "instructions": "Does this convey urgency?",
  "criteria": { "true": "Explicitly time-sensitive", "false": "No urgency expressed" }
}
```

Structured instructions (question in one field, data in the others, referenced by backticked name), copied from https://docs.typesafe.ai/api.md:
```json
"instructions": {
  "potential_duplicate": { "name": "John Smith", "location": "Oakland, California", "last_employer": "Google" },
  "question": "Is the resume for the same person as `potential_duplicate`?"
}
```

Structured Choice options with `null` descriptions and object rubrics, copied from https://docs.typesafe.ai/primitives/choice.md:
```json
"tone": { "type": "choice", "instructions": "What is the customer's tone?", "criteria": { "calm": null, "frustrated": null, "angry": null } }
```
```json
"return_topic": {
  "type": "choice",
  "instructions": { "question": "Which returns topic is the customer asking about?", "focus": "Classify the information the customer wants." },
  "criteria": {
    "return_policy": { "what": "Whether and how an item can be returned", "not_for": "Progress of a return already sent", "examples": ["Can I return shoes I've worn once?", "How long do I have to return an order?"] },
    "return_status": { "what": "Progress of a return already sent", "not_for": "Whether and how an item can be returned", "examples": ["Has my return arrived yet?", "When will my refund be paid?"] }
  }
}
```
Field names inside instructions and criteria objects (`question`, `focus`, `what`, `not_for`, `examples`, …) are free-form; none are reserved. The model sees both keys and values.

State paths: reference nested state in instructions with backticks, e.g. ``"Does `ticket.messages[0].text` request a refund?"`` (https://docs.typesafe.ai/primitives.md).

The Python SDK's `extra_body` shallow-merges extra top-level fields. Its docs example `{"beam_width": 4}` is explicitly "illustrative", so no extra fields are documented as supported.

## 3. Response body (exact field names)

OpenAPI `SystemOneResponse`, required `["model","answers","usage"]`:
```json
{
  "model": "jev-1.13.0",
  "answers": {
    "department": {
      "type": "choice",
      "choice": "technical",
      "confidence": 0.78,
      "probabilities": { "technical": 0.85, "sales": 0.0, "billing": 0.15 }
    },
    "frustration": {
      "type": "score",
      "score": 1.0,
      "confidence": 1.0,
      "legend": { "0": "Calm, just stating facts", "1": "Frustrated but civil", "2": "Very angry, strong language" },
      "probabilities": { "0": 0.0, "1": 1.0, "2": 0.0 }
    },
    "is_urgent": { "type": "noul", "noul": 1.0 }
  },
  "usage": { "input_tokens": 392, "output_tokens": 65 }
}
```
(copied from https://docs.typesafe.ai/introduction/quickstart.md)

| primitive | fields | meaning |
|---|---|---|
| noul | `type`, `noul` | P(yes) in 0..1; **no `confidence`** |
| choice | `type`, `choice`, `probabilities{option: p}`, `confidence` | `choice` = argmax; probabilities "sum to approximately 1" (OpenAPI) |
| score | `type`, `score`, `legend{"i": desc}`, `probabilities{"i": p}`, `confidence` | `score = Σ i·p_i` (e.g. `0×0.0 + 1×0.57 + 2×0.43 = 1.43`) |

- `model` in the response is the **versioned ID** that answered, even when you sent an alias (docs). Note the OpenAPI example shows "jev-latest", which is inconsistent.
- Score keys are strings on the wire. The Python SDK converts them to `dict[int, …]`; JS keeps them as string-indexed keys.
- Probability key order does not follow request order (the quickstart returns technical/sales/billing), so never rely on ordering.
- Docs examples show values rounded to 2 decimals. `[INFERENCE]` Actual precision is unverified.
- `usage.output_tokens` is "currently free of charge" (OpenAPI).

### Confidence formulas
The docs say only "derived from probabilities". The Choice demo uses `(3 × largest − 1)/2` as an approximation for three options. TypeSafe's own LLM adapter (`system-one-adapter-python/src/system_one_adapter/_utils/confidence_metrics.py`) implements:
```python
def choice_confidence(probs):   # (pmax - 1/n) / (1 - 1/n)
    u = 1.0/len(probs); return (max(p) - u) / (1.0 - u)

def score_confidence(probs):    # 1 - E|i - mode| / MAD(uniform)
    mode = argmax(p); dist = sum(p_i*abs(i-mode))
    center = (n-1)/2; mad_u = sum(abs(i-center) for i in range(n))/n
    return max(0.0, 1.0 - dist/mad_u)
```
Checked by hand against the docs examples:
- Choice (0.61, 0.35, 0.04) gives 0.415, docs 0.42.
- Choice (0.40, 0.34, 0.24, 0.02) gives 0.20, docs 0.20.
- Choice (0.74, 0.26, 0, 0, 0) gives 0.675, docs 0.67.
- Score (0, 0.57, 0.43) gives 0.355, docs 0.35.
- Score (0, 0.95, 0.05) gives 0.925, docs 0.92.

`[INFERENCE]` The server very likely uses the same formulas. Either way the full `probabilities` are returned, so the gate can compute its own measure (the docs encourage this).

### Other response examples (copied)
From https://docs.typesafe.ai/primitives/choice.md, an ambiguous ticket:
```json
"department": { "type": "choice", "choice": "returns", "confidence": 0.42,
  "probabilities": { "shipping": 0.04, "billing": 0.35, "returns": 0.61 } },
"requested_resolution": { "type": "choice", "choice": "refund", "confidence": 0.2,
  "probabilities": { "replacement": 0.34, "refund": 0.4, "information": 0.02, "exchange": 0.24 } }
```
From https://docs.typesafe.ai/primitives/score.md:
```json
"bug_severity": { "type": "score", "score": 1.43, "confidence": 0.35,
  "legend": { "0": "Cosmetic; no impact to functionality", "1": "Broken or degraded feature, but workaround exists", "2": "Blocking issue; no workaround exists" },
  "probabilities": { "0": 0.0, "1": 0.57, "2": 0.43 } }
```

## 4. Errors, rate limits, retries, timeouts

Documented statuses (https://docs.typesafe.ai/api.md):

| status | meaning |
|---|---|
| 401 | Missing or invalid API key |
| 422 | Body failed validation; the body names the offending field |
| 429 | Rate limit exceeded; back off |
| 529 | TypeSafe overloaded; retry after a short delay |

422 body (OpenAPI `HTTPValidationError`, FastAPI style):
```json
{ "detail": [ { "loc": ["body", "state"], "msg": "Field required", "type": "missing" } ] }
```
`ValidationError` also carries optional `input` and `ctx` (e.g. `{"min_length": 1}`); an example `loc` is `["body","questions","urgency","score","criteria"]`.

The SDKs also parse other error bodies in this order: `error` (a string, or `{message}`), then `message`, then `detail` (a string, `{message}`, or the list above). Messages are truncated to 200 characters.

Status-to-exception mapping (JS `src/errors.ts` / Python `_core/errors.py`):

| status | JS class | Python class |
|---|---|---|
| 400 | `BadRequestError` | `TypeSafeBadRequestError` |
| 401 | `AuthenticationError` | `TypeSafeAuthenticationError` |
| 403 | `PermissionDeniedError` | `TypeSafePermissionDeniedError` |
| 404 | `NotFoundError` | `TypeSafeNotFoundError` |
| 422 | `UnprocessableEntityError` | `TypeSafeUnprocessableEntityError` |
| 429 | `RateLimitError` (with `.retryAfterMs`) | `TypeSafeRateLimitError` (with `.retry_after_ms`) |
| ≥500 (includes 529) | `InternalServerError` | `TypeSafeInternalServerError` |

Non-HTTP failures:
- JS: `APIConnectionError`, `APITimeoutError` (a subclass of connection error), `APIUserAbortError`.
- Python: `TypeSafeAPIConnectionError`, `TypeSafeAPITimeoutError`, and `TypeSafeAPIResponseValidationError` (a 2xx response with a malformed body; has `.field_path`).
- All errors expose status, body, headers and `requestId` / `request_id`.

Rate limits (https://docs.typesafe.ai/models.md): **250,000 tokens/s and 1,200 requests/min**, returning `429` when exceeded. They are "adjusting dynamically… can change without notice"; higher limits are available on custom or enterprise plans.

SDK retry defaults:
- **Both SDKs:** `maxRetries` 2 (3 attempts total); backoff starts at 0.5 s and doubles up to a 5 s cap; jitter subtracts up to 25%; retried statuses are 408, 429 and 500–599; `retry-after-ms` is preferred over `Retry-After` (seconds or HTTP date); connection errors and timeouts are retried.
- **JS specifics:** `timeout` is **10000 ms per attempt with no total budget**; `maxRetryAfterMs` is 60000, and longer server delays fall back to backoff.
- **Python specifics:** `DEFAULT_TIMEOUT` is 10.0 s per HTTP operation; `RetryPolicy.timeout` is **a 30.0 s total budget** that stops before a retry whose delay would exceed it. Python also accepts extra `exceptions` and a `predicate` for retrying.
- `[INFERENCE]` Worst-case JS wall time with defaults is about 3×10 s + 0.5 s + 1 s ≈ 31.5 s. A QA loop should pass tighter per-call timeouts.

Server-side request timeout: not documented.

## 5. Limits and size budget

- **Context:** "64k tokens per request; 32k tokens for `state` plus the longest question." The 64k budget covers state plus all questions combined (https://docs.typesafe.ai/models.md).
- **Choice options:** at most 255 (https://docs.typesafe.ai/api.md, the choice page, and the blog: "Jev supports a cardinality up to 255"). For more, go two-pass: pick a window, then rank inside it (semantic_find cookbook).
- **Score levels:** 2 to 10 (docs). The OpenAPI schema only enforces `minItems: 1`; the JS SDK enforces ≥2.
- **Questions per request:** no documented maximum beyond the token budget (OpenAPI only has `minProperties: 1`). Cookbooks use 13+ questions and one Choice with 218 options.
- **Input:** text only (string, JSON object, or array of text). No image, audio or video, so screenshots must be converted to text (accessibility tree or OCR) first.

## 6. Models, pricing, latency, languages

| name | points to | meaning |
|---|---|---|
| `jev-latest` | `jev-1.13.0` | latest stable; SDK default |
| `jev-preview` | `jev-1.13.0` | latest release including previews (currently the same model) |
| `jev-1.13.0` | versioned | pin this if you tuned thresholds |

- Cookbooks pin `"jev-1.12"` (guardrails numbers were produced by `jev-1.12` on 2026-08-15), and the jaggedness page uses `TypeSafeClient(model="jev-1.13")`. So shorter version strings appear in official code. `[INFERENCE]` Prefer the full `jev-1.13.0` form, which the models page names explicitly.
- The Python usage page shows `TypeSafeClient(model="jev")`, but `jev` is not a listed alias. `[unverified]`
- Jev is not fine-tuned per customer; the same weights serve every account.
- **Price:** $0.042 per Mtok ($42 per Btok), **charged on input tokens only; output tokens are free** (models page and blog).
- **Latency:**
  - Blog: "End-to-end response time is 70ms–500ms", measured from the US West Coast.
  - Parallel-questions cookbook: 13 questions over a 53,777-character document took 0.27 s in one call, versus 2.71 s for 13 sequential calls, and cost $0.000497 versus $0.006090 (12.2x cheaper, 10.0x faster, identical answers). `[INFERENCE]` That cost implies about 11.8k input tokens.
  - Primitives page: adding questions "barely changes the response time".
- **Languages:** "English is the primary training language and where accuracy is currently best. Other languages, including CJK scripts, are handled but not equally well; test on your own content… pay close attention to Confidence when routing." There are no Korean-specific figures in any primary source.
- **Data handling:** requests are not used for training; ZDR is available on enterprise plans; there is a DPA.

## 7. JS/TS SDK (`@typesafe-ai/sdk`)

- `npm install @typesafe-ai/sdk`; v0.6.0; Node ≥20; ESM and CJS builds; MIT; also published to JSR (`jsr.json`).
- Exports: `TypeSafeClient`, `choice`, `noul`, `score`, the error classes, `ENV`, `LOG_LEVELS`, `VERSION`, `APIPromise`, and all types.
- Environment variables: `TYPESAFE_API_KEY` (required), `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL`, `TYPESAFE_LOG_LEVEL` (`debug|info|warn|error|off`, default `warn`).
- Constructor options (`TypeSafeClientConfig`): `apiKey`, `baseURL`, `defaultModel`, `logLevel`, `logger`, `retry` (partial `RetryPolicy`), `timeout` (ms), `defaultHeaders`, `dangerouslyAllowBrowser` (default false; it **throws in browsers** otherwise), and `fetch`.
- Call signature: `client.systemOne({ state, questions, model? }, { signal?, timeout?, retry?, headers? })`. It returns `APIPromise<SystemOneResult<Q>>` with `.withResponse()` → `{data, response, requestId}`, plus `.asResponse()` and `.map()`.
- Answer types are inferred from the question literal: `ChoiceResponse<T>.choice` is typed `keyof T`, and Score `probabilities`/`legend` are keyed by tuple indices.
- Builder behaviour:
  - `noul(instructions = null, criteria?)` produces `{type:"noul", instructions, criteria}`.
  - `choice(instructions, criteria)` throws on an array.
  - `score(instructions, criteria)` throws on a non-array.
  - `validateQuestions` throws `"At least one question is required."` and rejects Score criteria that aren't a list or have fewer than 2 entries.
- Pitfalls:
  - The JS type `SystemOneRequest.state: EntryType` allows `null`, but the server requires `state` (the OpenAPI has no null), so it will return 422.
  - At `debug` log level, request and response **bodies are logged unredacted**; only credential headers are redacted.

Usage (copied from the README):
```ts
import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
const client = new TypeSafeClient();
const response = await client.systemOne({
  state: { document: "I was charged twice. Please fix this ASAP." },
  questions: { category: choice("What is this ticket about?", { billing: null, technical: null, other: null }) },
});
console.log(response.answers.category.choice);
```

## 8. Python SDK (`typesafe-sdk`)

- `pip install typesafe-sdk` / `uv add typesafe-sdk`; v0.7.1; Python ≥3.10; dependencies `httpx2`, `pydantic>=2.12`, `tenacity`; MIT.
- Clients: `TypeSafeClient` and `AsyncTypeSafeClient`, both usable as context managers. Constructor: `api_key`, `model`, `retry: RetryPolicy`, `timeout` (seconds or `httpx2.Timeout`), `headers`, `transport` or `http_client`, `base_url`.
- The API key is validated eagerly: whitespace is stripped, and keys with internal whitespace, non-ASCII or control characters are rejected.
- Call signature: `client.system_one(state, questions, *, model=None, retry=None, timeout=None, extra_headers=None, extra_body=None, response_model=None)`.
- Question types: `Choice(instructions=, criteria={…})`, `Score(instructions=, criteria=[…])`, `Noul(instructions=, criteria=NoulCriteria(true=, false=))`. Raw dicts are also accepted, and fields left at `None` are omitted from the wire.
- Response: `SystemOneResponse` with `.model`, `.usage`, `.answers`, the typed views `.nouls`, `.choices`, `.scores`, plus `.request_id` and `.raw_http_response`.
- Unknown answer types are skipped with a warning (forward compatibility), and a custom Pydantic `response_model` is supported.

Example (copied from https://docs.typesafe.ai/primitives/noul.md):
```python
from typesafe_sdk import Noul, NoulCriteria, TypeSafeClient
with TypeSafeClient() as client:
    response = client.system_one(
        model="jev-latest",
        state="I have asked three times now. Can I please just talk to a real person?",
        questions={
            "is_human_escalation": Noul(instructions="Is the customer asking for a human agent?"),
            "is_repeat_contact": Noul(
                instructions="Has the customer contacted support about this before?",
                criteria=NoulCriteria(true="Mentions a prior attempt, ticket, or that they have asked before",
                                      false="No sign of any previous contact"),
            ),
        },
    )
```

## 9. Documented gating and threshold patterns

These are examples to tune on our own data, not rules.

- **Confidence page:** use three bands (high: act; medium: confirm or review; low: don't act). Example gates:
  - `confidence < 0.5` → human.
  - A destructive action requires `> 0.9`, else ask the user to confirm.
- **Confidence-routing pattern:** below 0.6 → support agent; `check_balance` is allowed at ≥0.6; `approve_transfer` asks for confirmation between 0.6 and 0.85 and auto-approves above 0.85.
- **Choice page:** `department.confidence < 0.3` → manual triage; `resolution.confidence < 0.5` → ask the customer; a second team gets a copy if its probability is > 0.25.
- **Noul page:** `YES=0.8`, `NO=0.2`; anything in between goes to review.
- **Guardrails cookbook:**
  - Policies: strict `{review_threshold: 0.35, action_threshold: 0.70, severity_block: 2.0}`, permissive with action at 0.85.
  - Precedence: `support > block > review > pass`.
  - A severity Score ≥ 2.0 upgrades a review to a block.
- **Line-by-line search cookbook:** `FOUND, ABSENT = 0.7, 0.35` for the `exists` Noul ("present answers typically read >=0.9, absent <=0.05").

## 10. Known model failure modes (jev-1.13 jaggedness, reviewed 2026-09-17)

Source: https://docs.typesafe.ai/model-jaggedness/jev-1.13.md. Each item is followed by the documented workaround.

- **Literal reading:** state the exact condition and put boundary cases in criteria.
- **Math, counting, numeric representations** (hex colours, coordinates): keep them in code, and ask one Noul per item before summing in code.
- **Dates:** extract the parts with a Choice and compare them in code.
- **Indirection or double negatives:** reduce hops and name the relevant part of the state.
- **Large state full of irrelevant detail:** accuracy drops ("context rot"), so filter in code first.
- **Adversarial content in `state` can move answers.** State is not treated as hostile; be explicit in the criteria.
- **Contradictory instructions and criteria** hurt accuracy.
- **No structural invariants:** a Noul's P(yes) and a yes/no Choice differ (0.22 vs 0.01), and a question plus its negation summed to 1.19. Don't reuse thresholds across primitives.
- **Generation:** not supported; select from candidates instead.

## 11. Implications for app-qa

These are my recommendations, derived from the facts above.

1. **Target selection:** send one `choice` whose criteria keys are our candidate IDs (e.g. `"E017"`). Descriptions can be `null` if the state already lists each candidate's text, role and bounds, or can be short objects. Always add a `none_of_these` option, **and** ask a parallel `noul`, "Does any candidate satisfy `goal`?". The Choice is relative and always picks something; the Noul is absolute. Beyond 255 candidates, use a two-pass window.
2. **Put everything in one request:** target choice, action-type choice, screen-state nouls ("is a modal or permission dialog present?", "is the screen still loading?"), and assertion nouls. Questions don't see each other's answers; code composes them.
3. **Gate:**
   - Use `confidence` for Choice/Score and bands for Noul (e.g. ≥0.8 yes, ≤0.2 no, otherwise review).
   - Start from conservative doc values and use stricter gates for Korean text and destructive actions.
   - Fail closed on any `TypeSafeError`, on 422 (a bug in our code), on exhausted 429/529 retries, and on `TypeSafeAPIResponseValidationError`.
4. **Pin `jev-1.13.0`.** Log the response `model`, `usage`, `x-typesafe-request-id`, and the full question/answer JSON in the receipt.
5. **Budget:** keep the serialized screen state well under 32k tokens (state plus the longest question). Prune invisible or unlabelled nodes, since irrelevant detail lowers accuracy.
6. **Keep coordinates and numbers in code.** Jev is weak at numeric proximity, so it should see semantic labels, not pixel math.
7. **Treat on-screen text as untrusted** (prompt-injection risk). Keep execution authority in allowlisted code.
8. **Set explicit per-call timeouts** (e.g. JS `timeout: 3000`, `retry: {maxRetries: 1}`). JS has no total retry budget by default.
9. **Treat Jev as a US-hosted service.** There is no EU or APAC endpoint; account for latency and data residency, and ask about ZDR if screens contain personal data.

## 12. Doc and SDK inconsistencies found

- The advanced page says Score `criteria` entries accept `null`; the OpenAPI `ScoreQuestion.criteria.items` excludes null.
- The API docs say `instructions` is required; OpenAPI and both SDKs treat it as optional or nullable.
- The JS `state` type allows `null`; the OpenAPI requires a string, object or array.
- The Score level count is "at least two" in docs, `minItems: 1` in OpenAPI, ≥2 in the JS SDK and ≥1 in the Python SDK.
- The skill's migration-guide link `https://docs.typesafe.ai/migrating-to-v1.md` returns **404**.
- The primitives page quotes "11.5x cheaper and 9.6x faster"; the cookbook itself reports 12.2x and 10.0x (numbers from a rerun).
- The guardrails cookbook reads `TYPESAFE_ENDPOINT` and passes it manually as `base_url`. The SDK itself reads `TYPESAFE_BASE_URL`.
- The OpenAPI `SystemOneResponse.model` example is "jev-latest", but the docs say the versioned ID is returned.

## 13. Licenses
- `typesafe-sdk-js`: MIT
- `typesafe-sdk-python`: MIT
- `system-one-adapter-python`: MIT
- `skills`: MIT

(GitHub org page and package metadata.)