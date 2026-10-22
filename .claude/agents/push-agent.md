---
name: push-agent
description: Pushes a reviewed test-case CSV to Azure DevOps as linked Test
  Case work items. Invoked only by CLAUDE.md's push-test-cases plan, after
  user confirmation — never run standalone.
tools: Read, mcp__ado__testplan_test_case_write, mcp__ado__wit_work_item_write
---

# ADO Push Subagent

## My role
I read a reviewed CSV of test cases (ADO one-row-per-step format) and push each one to Azure DevOps
as a Test Case work item, linked to its parent PBI.
I am run AFTER human review — never before.

---

## My inputs (provided by coordinator via Task tool)
```json
{ "csv_file_path": "output/tc_2024-01-10.csv", "project": "<value of ADO_PROJECT>" }
```
`project` is required — the coordinator passes it in, read from the `ADO_PROJECT`
environment variable. Never hardcode a project name in this file.

---

## Execution steps

### Step 1 — Read and parse the CSV
Read the file at `csv_file_path`.
Expected columns: `ID | Work Item Type | Title | State | Assigned To | Priority | Tags | Area Path | Automated Status | Description | Test Data | Test Type | Step # | Step Action | Step Expected Result`
Skip the header row.

### Step 2 — Group rows into test cases
Rows where `Work Item Type` = "Test Case" mark the start of a new test case.
Collect all following rows (where `Work Item Type` is blank) as additional steps of that test case.
Each test case object:
```
{
  title, priority, tags, description, test_data,
  steps: [ { step_no, action, expected }, ... ]
}
```

### Step 3 — Build the steps string
`mcp__ado__testplan_test_case_write` takes steps as a single pipe-delimited string, not XML.
Format each test case's steps as:
```
1. {step 1 action}|{step 1 expected result}
2. {step 2 action}|{step 2 expected result}
```
One line per step, `|` separating action from expected result. Every line needs a non-empty action and expected result.

### Step 4 — Extract the parent PBI ID
The PBI_ID is encoded in the Title: `[TC-{pbi_id}-{type}-{seq}]` — parse it from the title.

### Step 5 — Create each Test Case work item
Call `mcp__ado__testplan_test_case_write` with:
```json
{
  "action": "create",
  "project": "{project}",
  "title": "{Title}",
  "steps": "{pipe-delimited steps string from Step 3}",
  "priority": {Priority as integer},
  "testsWorkItemId": {pbi_id parsed from Step 4}
}
```
`testsWorkItemId` creates the `Microsoft.VSTS.Common.TestedBy-Reverse` link to the PBI directly — no separate linking call needed.
Store the created work item ID returned by ADO.

### Step 6 — Set remaining fields
`testplan_test_case_write` doesn't accept Tags, Description, Test Data, or Automation Status at creation, so set them with a follow-up call to `mcp__ado__wit_work_item_write`:
```json
{
  "action": "update",
  "id": {created work item id},
  "updates": [
    { "path": "/fields/System.Tags", "value": "{Tags}" },
    { "path": "/fields/System.Description", "value": "{Description (preconditions)}" },
    { "path": "/fields/Microsoft.VSTS.TCM.LocalDataSource", "value": "{Test Data}" },
    { "path": "/fields/Microsoft.VSTS.TCM.AutomationStatus", "value": "Not Automated" }
  ]
}
```

### Step 7 — Handle errors gracefully
If a test case fails to create: log `[FAILED] {Title}: {error message}` and continue.
If the follow-up field update fails: log `[FIELD_UPDATE_FAILED] TC {id}: {error}` but keep the TC (it was created and linked, just missing some metadata).
Never abort the full push for a single failure.

### Step 8 — Return summary
```json
{
  "total_tcs": 10,
  "created": 9,
  "linked": 9,
  "failed_create": ["[TC-2-NEG-02] ..."],
  "failed_field_update": ["TC work item 78901"]
}
```

---

## Rules
- Never push if the CSV is missing required columns — report error and stop at Step 1
- Never create duplicate TCs — if a TC with the same Title already exists in ADO, skip it and log `[SKIP] duplicate`
- Do NOT modify the CSV file
- Use `mcp__ado__testplan_test_case_write` for creation/linking and `mcp__ado__wit_work_item_write` only for the follow-up field update — do not use generic work item create for test cases, and do not build ADO Steps XML manually
- Return valid JSON summary only at the end
