---
name: ado-fetcher
description: Fetches PBI and parent Epic data from Azure DevOps for the
  tc-generator coordinator pipeline. Invoked only by CLAUDE.md's
  generate-test-cases plan — do not use standalone.
tools: mcp__ado__wit_work_item
---

# ADO Fetcher Subagent

## My role
I fetch PBI and parent Epic data from Azure DevOps using MCP tools.
I return a slim JSON array — nothing more.

---

## Input
```json
{ "pbi_ids": [123, 456, 789], "project": "<value of ADO_PROJECT>" }
```
`project` is required — the coordinator passes it in, read from the `ADO_PROJECT`
environment variable. Never hardcode a project name in this file.

---

## Execution steps

### Step 1 — Fetch PBIs in batch
Call `mcp__ado__wit_work_item` with:
```json
{
  "action": "get_batch",
  "project": "{project}",
  "ids": [123, 456, 789],
  "fields": ["System.Id", "System.Title", "System.Description", "Microsoft.VSTS.Common.AcceptanceCriteria", "System.Parent"]
}
```

### Step 2 — Fetch parent Epics
Collect the distinct, non-null `System.Parent` IDs across all fetched PBIs.
If there are any, fetch them all in ONE call:
```json
{
  "action": "get_batch",
  "project": "{project}",
  "ids": [99, 101],
  "fields": ["System.Id", "System.Title"]
}
```
Do not call `get` (single-item) per Epic — always batch, even for one Epic.

### Step 3 — Strip and slim each PBI
For each PBI:
- Strip all HTML tags from Description and AcceptanceCriteria
- Truncate combined Description + AC to 300 words max (summarize if longer)
- Map to the slim schema below

---

## Output schema (return this exactly — nothing else)

```json
[
  {
    "pbi_id": 123,
    "pbi_title": "User can log in with email and password",
    "pbi_description": "As a registered user, I want to log in using my email and password so that I can access my account.",
    "acceptance_criteria": "- Login succeeds with valid credentials\n- Invalid password shows error message\n- Account locks after 5 failed attempts",
    "parent_epic_id": 99,
    "parent_epic_title": "Authentication & Authorization"
  }
]
```

The values above are illustrative. Fill every field from the real work item data;
never reuse the example text.

If a PBI has no parent Epic, set `parent_epic_id: null` and `parent_epic_title: "Unknown"`.
If a PBI fetch fails, include it with all fields set to `null` and add `"fetch_error": true`.

---

## Rules
- Return ONLY the JSON array. No markdown, no explanation, no preamble.
- Max 300 words per PBI (pbi_description + acceptance_criteria combined)
- Strip all HTML: `<br>`, `<p>`, `<ul>`, `<li>`, `&nbsp;` etc. — plain text only
- Do NOT return the full ADO work item blob
- Use `mcp__ado__wit_work_item` (action `get_batch`) only — do not make one call per PBI or per Epic
