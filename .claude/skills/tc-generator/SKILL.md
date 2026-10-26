---
name: tc-generator
allowed-tools: Read, Write
description: Rules for how the tc-subagent generates test cases from PBI data. Preloaded into tc-subagent only; the coordinator never generates test cases itself.
---

# TC Generation Rules

## My inputs
I receive these parameters from the coordinator (never request more):
- `pbi_id` — integer
- `pbi_title` — string
- `pbi_description` — string
- `acceptance_criteria` — string
- `parent_epic_title` — string (domain context)
- `context_summary` — string, max 500 words (may be empty)

The ADO schema (`ado-schema` skill) is preloaded alongside this skill.

---

## Generation strategy

### Step 1 — Understand the PBI domain
Read `parent_epic_title` + `pbi_title` + `pbi_description` to identify:
- What feature/capability is being built
- What system/component is involved (API, UI, DB, etc.)
- What the user role is (admin, standard user, guest, etc.)

### Step 2 — Extract test conditions from Acceptance Criteria
Parse each AC bullet into testable conditions:
- "User can X" → Positive TC
- "System must reject Y" → Negative TC
- "Response must be < N ms" → Performance TC
- "Field accepts max N characters" → Edge Case + Boundary TC

### Step 3 — Use context_summary if provided
If `context_summary` is non-empty:
- Extract integration points → add to Description (preconditions)
- Regression scripts: if the summary lists existing regression tests by name, tag a TC `regression` ONLY when
  it exercises the same scenario as one of them. When you tag it, add one bullet to its Description,
  `• Matches regression script: <script name, exactly as listed>`, so a reviewer can check the match.
  If you are not sure, do not tag. A TC is not a regression TC just because it is a login or smoke test.
  If the summary lists no regression scripts, never use the `regression` tag.
- Extract system constraints → enrich Step Expected Result with specifics
- Do NOT request the full files — work only from the summary

### Step 4 — Generate TCs
Generate the minimum count per type (from the preloaded `ado-schema` skill).
Generate more if the AC clearly suggests additional scenarios.

---

## Prompt variants

### Variant A — With context_summary (context_summary is non-empty)
Use the context to:
- Add preconditions based on system dependencies from HLD
- Tag TCs that match a named regression script with `regression` and name the script (see Step 3)
- Enrich step expected results with system-specific detail (e.g. exact error codes from HLD)

### Variant B — Without context_summary (context_summary is empty string)
Derive everything from PBI data alone.
Use generic but realistic test data.
Do not invent system-specific details that aren't in the PBI.

---

## Step writing rules — apply to every step of every TC

Each step has TWO parts: a concrete action AND an immediate expected result.

### Step Action rules
- **UI steps**: name the exact element + action + literal value. `Click the "Login" button on the login form` not `Click submit`.
- **Input steps**: include the literal value from Test Data. `Type "invalidemail.com" into the Email field` not `Enter invalid email`.
- **API steps**: include method + path + exact body/headers. `Send POST /api/v1/auth/login with body {"email":"user@test.com","password":"Wrong99"}`.
- One action only per step — do not combine two actions into one step.

### Step Expected Result rules
- Every step must have a non-empty expected result — not just the last step.
- Intermediate steps: what the tester sees immediately after this action. `Email is accepted and displayed in the field`
- Last step: full pass/fail statement starting with `TEST PASS —` or `TEST FAIL —`. Example: `TEST PASS — URL reads /dashboard, user is authenticated, session cookie is set`
- For negative TCs last step: `TEST PASS — error message "Invalid email or password" displayed, URL remains /login`
- For performance TCs last step: `TEST PASS — P95 < 500ms, error rate < 1%, throughput > 50 req/s`

### Step count guidance
- Simple UI TCs: 4–6 steps
- Negative / validation TCs: 5–7 steps
- Performance TCs: 5 steps (configure → execute → monitor → collect → compare SLA)
- Boundary TCs: 6–8 steps (test below boundary, at boundary, above boundary)

---

## Quality rules — self-check before returning

Before returning your JSON array, verify every TC:

1. **Title** follows `[TC-{pbi_id}-{TYPE}-{n}] ...` convention
2. **Steps array** has 4–8 items, each with non-empty `action` and `expected`
3. **Step actions** use actual test data values — not "valid email", not "correct password"
4. **Step expected results** are specific — not "it works", not "verify result"
5. **Last step expected** starts with `TEST PASS —` and states full outcome
6. **Description** (preconditions) is a bullet list using `• ` bullets (never `- `) — not vague, not empty. No field may start with `=`, `+`, `-`, or `@`.
7. **Test Data** has concrete values — not "valid data"
8. **Tags** include type tag and domain tag
9. **Performance TCs** have SLA values in last step expected and tool in Test Data
10. **Boundary TCs** reference specific values from AC (not generic "min" or "max")
11. Minimum TC counts per type are met
12. No two TCs have identical step actions

---

## Output format — strict

Return a valid JSON array. Nothing else — no markdown, no explanation, no preamble.

**Steps must be a JSON array of objects** — each object has `step_no`, `action`, `expected`.
The coordinator uses this array to write the output file.

```json
[
  {
    "TC_ID": "",
    "Title": "[TC-123-POS-01] Login succeeds with valid email and password",
    "Test_Type": "Positive",
    "Priority": "1",
    "Description": "• User account exists with email: user@test.com and password: ValidPass1!\n• Account is active and not locked\n• User is on the login page at /login",
    "Test_Data": "email: user@test.com, password: ValidPass1!, endpoint: POST /api/v1/auth/login",
    "Tags": "positive, auth, login, smoke",
    "PBI_ID": "123",
    "PBI_Title": "User can log in with email and password",
    "Steps": [
      { "step_no": 1, "action": "Navigate to https://app.example.com/login", "expected": "Login page loads with Email field, Password field, and Login button visible" },
      { "step_no": 2, "action": "Type \"user@test.com\" into the Email field", "expected": "Email is accepted and displayed in the field" },
      { "step_no": 3, "action": "Type \"ValidPass1!\" into the Password field", "expected": "Characters are masked as asterisks or dots" },
      { "step_no": 4, "action": "Click the \"Login\" button on the login form", "expected": "Browser begins processing the form submission" },
      { "step_no": 5, "action": "Observe the browser URL and page content after redirect", "expected": "TEST PASS — URL reads /dashboard, user is authenticated, session cookie is set" }
    ]
  }
]
```

The `regression` tag is not one of the usual tags: use it only under the rule in Step 3.

Leave `TC_ID` as empty string — coordinator assigns it during merge.
`PBI_ID` and `PBI_Title` must match the inputs passed to you exactly.
`Description` = preconditions bullet list.
`Steps` = JSON array, NOT a string. Each step has `step_no` (integer), `action` (string), `expected` (string).

---

## Common mistakes to avoid
- Do NOT return Steps as a string — it must be a JSON array
- Do NOT write "Verify that..." in expected — write the actual state
- Do NOT write "Enter valid data" in action — write the actual value
- Do NOT skip Description — even "None" is a valid value
- Do NOT start Description bullets (or any field) with `- ` / `=` / `+` / `@` — use `• ` for bullets
- Do NOT generate duplicate scenarios with different wording
- Do NOT return markdown-wrapped JSON (no ```json fences)
- Do NOT include TC_ID values — leave them as empty string
