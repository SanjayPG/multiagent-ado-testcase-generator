---
name: ado-schema
allowed-tools: Read, Write
description: Defines the ADO Test Case CSV schema that matches ADO's native export format. One row per step. Directly importable into ADO without any agent. Preloaded into tc-subagent; the coordinator uses it when merging and writing the CSV.
---

# ADO Test Case Schema

## CSV format — one row per step (matches ADO export)

Each test case produces **multiple rows** — one per step. The test case metadata columns are filled only on the first step row; all other step rows leave them blank.

### Column order (exact — do not change)
```
ID | Work Item Type | Title | State | Assigned To | Priority | Tags | Area Path | Automated Status | Description | Test Data | Test Type | Step # | Step Action | Step Expected Result
```

---

## Column definitions

### ID
Leave blank for new test cases. ADO assigns the ID on import/creation.

### Work Item Type
Always `Test Case`. Fill on first step row only. Blank on all subsequent step rows.

### Title
Format: `[TC-{pbi_id}-{type_code}-{seq}] {short imperative description}`
Example: `[TC-123-NEG-01] Login returns error when password is incorrect`
Max 120 characters. Imperative verb. No "Test that..." prefix.
Fill on first step row only. Blank on all subsequent step rows.

Type codes: `POS`, `NEG`, `EDGE`, `PERF`, `BOUND`

### State
Always `Design` for new test cases. Fill on first step row only.

### Assigned To
Leave blank. Fill on first step row only.

### Priority
- `1` = Critical (system down, data loss, security)
- `2` = High (core feature broken)
- `3` = Medium (non-core feature, workaround exists)
- `4` = Low (cosmetic, nice-to-have)
Fill on first step row only. Blank on all subsequent step rows.

### Tags
Comma-separated lowercase tags. Always include type tag + domain tag.
Standard tags: `smoke`, `regression`, `positive`, `negative`, `edge-case`, `performance`, `boundary`
Domain tags (examples): `auth`, `login`, `payment`, `api`, `ui`, `db`, `session`
Fill on first step row only. Blank on all subsequent step rows.

### Area Path
Leave blank (ADO will use project default). Fill on first step row only.

### Automated Status
Always `Not Automated`. Fill on first step row only.

### Description
Put the Preconditions here. Format as a bullet list using `• ` (U+2022) as the bullet — NOT `- `.
A leading `-` makes spreadsheets treat the cell as a formula and show `#NAME?`.
```
• User account exists with email: user@test.com
• User is on the login page at /login
• No active session exists
```
Max 5 bullets. If none needed, write `None`.
Fill on first step row only. Blank on all subsequent step rows.
No cell value may start with `=`, `+`, `-`, or `@`.

### Test Data
Concrete data values used in the test.
Format: `field: value, field: value`
Example: `email: user@test.com, password: ValidPass1!, endpoint: POST /api/v1/auth/login`
If no specific data needed, write `N/A`.
Fill on first step row only. Blank on all subsequent step rows.

### Test Type
Allowed values (use exactly):
- `Positive`
- `Negative`
- `Edge Case`
- `Performance`
- `Boundary`
Fill on first step row only. Blank on all subsequent step rows.

### Step #
The step number: `1`, `2`, `3`... Fill on every row.

### Step Action
One concrete action — name the exact element, include the literal value.
- UI: `Click the "Login" button on the login form`
- Input: `Type "invalidemail.com" into the Email field`
- API: `Send POST /api/v1/auth/login with body {"email":"user@test.com","password":"Wrong99"}`
Do NOT write vague actions like "Enter valid data" or "Click submit".
Fill on every row.

### Step Expected Result
What the tester sees immediately after this step's action.
- Intermediate steps: `Email is accepted and displayed in the field`
- Last step: `TEST PASS — URL reads /dashboard, session cookie is set` (or `TEST PASS — error "Invalid email or password" shown, URL stays /login`)
Every step must have a non-empty expected result — not just the last step.
Fill on every row.

---

## Row layout example

A field containing a comma, a quote or a newline is wrapped in double quotes.

```
ID,Work Item Type,Title,State,Assigned To,Priority,Tags,Area Path,Automated Status,Description,Test Data,Test Type,Step #,Step Action,Step Expected Result
,Test Case,[TC-123-POS-01] Login succeeds with valid credentials,Design,,1,"positive, auth, login, smoke, regression",,Not Automated,"• User account exists with email: user@test.com and password: ValidPass1!
• Account is active and not locked
• User is on the login page at /login","email: user@test.com, password: ValidPass1!, endpoint: POST /api/v1/auth/login",Positive,1,Navigate to https://app.example.com/login,"Login page loads with Email field, Password field, and Login button visible"
,,,,,,,,,,,,,2,Type "user@test.com" into the Email field,Email is accepted and displayed in the field
,,,,,,,,,,,,,3,Type "ValidPass1!" into the Password field,Characters are masked as asterisks or dots
,,,,,,,,,,,,,4,Click the "Login" button on the login form,Browser begins processing the form submission
,,,,,,,,,,,,,5,Observe the browser URL and page content,"TEST PASS — URL reads /dashboard, user is authenticated, session cookie is set"
```

---

## TC type minimum counts per PBI

| Type | Minimum | Focus |
|---|---|---|
| Positive | 2 | Happy path, expected inputs, successful outcomes |
| Negative | 3 | Invalid input, auth failure, missing fields, wrong type |
| Edge Case | 2 | Boundary violations, empty string, max-length, special chars, null, concurrent |
| Performance | 1 | API/DB response time, load, SLA threshold (only if PBI touches API or DB) |
| Boundary | 1 | Min/max values from acceptance criteria |

If a PBI has no API or DB interaction, Performance TCs can be omitted.
Total minimum: 9 TCs per PBI.

---

## Rules for specific TC types

### Negative TCs — must cover at least 3 of:
- Missing required field
- Invalid data type or format (e.g. email without @)
- Value out of allowed range
- Unauthorized / unregistered access attempt
- Duplicate submission
- Malformed request body

### Edge Case TCs — must cover at least 2 of:
- Empty string input
- Maximum allowed length input
- Special characters (`<>'";&%`)
- Null / undefined value
- Concurrent requests (race condition)
- Boundary ±1 values

### Performance TCs:
- Test Data must include: `concurrent_users: N, duration: Xs, tool: k6`
- Last step expected result must include: `P95 < Xms, error_rate < Y%, throughput > Z req/s`

### Boundary TCs:
- Derive min/max from Acceptance Criteria
- Test at boundary-1, boundary, boundary+1

---

## Title naming convention

| Type | Pattern | Example |
|---|---|---|
| Positive | `[TC-{id}-POS-{n}] {feature} succeeds with {valid condition}` | `[TC-101-POS-01] Login succeeds with valid credentials` |
| Negative | `[TC-{id}-NEG-{n}] {feature} returns {error} when {bad condition}` | `[TC-101-NEG-01] Login returns error when password is incorrect` |
| Edge Case | `[TC-{id}-EDGE-{n}] {feature} handles {extreme condition}` | `[TC-101-EDGE-01] Login handles password with special characters` |
| Performance | `[TC-{id}-PERF-{n}] {endpoint} meets SLA under {load}` | `[TC-101-PERF-01] POST /login meets SLA under 100 concurrent users` |
| Boundary | `[TC-{id}-BOUND-{n}] {field/behaviour} at {boundary condition}` | `[TC-101-BOUND-01] Session active at 29m59s but expires at 30m00s` |
