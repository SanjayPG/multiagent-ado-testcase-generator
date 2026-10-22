# ADO TC Generator Agent

An AI-powered, multi-agent test case generator for Azure DevOps.
Built with Claude Code, MCP, and parallel subagents. https://youtube.com/playlist?list=PLTTtCOmLVLIw&si=Kxdqpx-GdUd9uFsU

Reads Epics + PBIs directly from ADO, generates structured test cases (Positive, Negative, Edge Case, Performance, Boundary), exports to CSV for human review, then pushes back to ADO with PBI linking on your command.

---

<img width="1014" height="648" alt="flow1" src="https://github.com/user-attachments/assets/16d3250a-2ac3-4256-b94f-0958e60eb278" />


## Architecture

```
CLAUDE.md (coordinator)
├── .claude/agents/ado-fetcher.md   ← reads from ADO via MCP
├── .claude/agents/tc-subagent.md   ← generates TCs (one per PBI, runs in parallel)
├── .claude/agents/push-agent.md    ← writes back to ADO via MCP
├── .claude/skills/ado-schema/       ← ADO TC field format + naming rules (preloaded into tc-subagent)
├── .claude/skills/tc-generator/     ← TC generation logic + quality rules (preloaded into tc-subagent)
├── context/                         ← optional HLD and regression scripts
└── output/                          ← generated CSV files land here
```

Each of the three agents is a registered Claude Code custom agent (YAML
frontmatter with `name`/`description`/`tools` in `.claude/agents/`), always
spawned explicitly by name from `CLAUDE.md` — never invoked via auto-delegation.

---

## Prerequisites

- [Claude Code](https://claude.ai/code) installed (`npm install -g @anthropic-ai/claude-code`)
- Node.js 18+ (the ADO MCP server runs through `npx`)
- An Azure DevOps account with access to the project, and a PAT (steps below) with **Work Items (Read & Write)** and **Test Management (Read & Write)** scopes

---

## Setup

### 1. Get your Azure DevOps values

You need three values. None of them go into a file in this repo.

| Variable | What it is | Where to find it |
|---|---|---|
| `ADO_ORG` | Organization name | `https://dev.azure.com/<ADO_ORG>` — the segment after `dev.azure.com/` |
| `ADO_PROJECT` | Project name | The project's name in the ADO header / URL: `https://dev.azure.com/<ADO_ORG>/<ADO_PROJECT>` |
| `ADO_PAT_B64` | Your PAT, base64-encoded | Created in the next step |

**Create the PAT**

1. Sign in at `https://dev.azure.com/<ADO_ORG>`.
2. Top-right, click **User settings** (person icon with a gear) → **Personal access tokens**.
3. Click **+ New Token**.
4. Name it (e.g. `tc-generator`), pick your organization, and set a short expiry (30–90 days).
5. Under **Scopes** choose **Custom defined**, then enable:
   - **Work Items** → Read & write
   - **Test Management** → Read & write
6. Click **Create** and copy the token now — ADO never shows it again.

**Encode it as base64**

The ADO MCP server expects `PERSONAL_ACCESS_TOKEN` to be the base64 of `<email>:<pat>`
(the email can be any non-empty value, but use yours). Encode the pair, not the bare PAT.

PowerShell:
```powershell
$env:ADO_PAT_B64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("you@company.com:YOUR_PAT"))
```

bash/zsh/Git Bash:
```bash
export ADO_PAT_B64="$(printf '%s' 'you@company.com:YOUR_PAT' | base64 | tr -d '
')"
```

### 2. Set the environment variables

`.mcp.json` holds the server config. **Nothing in it is hardcoded** — the organization, PAT and
project are `${...}` references that Claude Code expands from your environment at launch:

```json
{
  "mcpServers": {
    "ado": {
      "command": "npx",
      "args": ["-y", "--package=@azure-devops/mcp", "mcp-server-azuredevops", "${ADO_ORG}", "--authentication", "pat"],
      "env": {
        "PERSONAL_ACCESS_TOKEN": "${ADO_PAT_B64}",
        "ado_mcp_project": "${ADO_PROJECT}"
      }
    }
  }
}
```

Set all three **before** launching Claude Code, in the same terminal. The coordinator also reads
`ADO_PROJECT` to tell the subagents which project to use.

**PowerShell (current session only):**
```powershell
$env:ADO_ORG = "your-org"
$env:ADO_PROJECT = "your-project"
$env:ADO_PAT_B64 = "<base64 from step 1>"
```

**PowerShell (persisted for your Windows user account):**
```powershell
setx ADO_ORG "your-org"
setx ADO_PROJECT "your-project"
setx ADO_PAT_B64 "<base64 from step 1>"
```
(open a new terminal after `setx` for it to take effect)

**bash/zsh:**
```bash
export ADO_ORG="your-org"
export ADO_PROJECT="your-project"
export ADO_PAT_B64="<base64 from step 1>"
```

Check it worked: start `claude`, run `/mcp`, and confirm `ado` shows as connected. If it times out or
fails, the usual causes are a variable that is unset in that terminal, a PAT that was base64-encoded
without the `email:` prefix, or an expired PAT.

`.mcp.json` only contains `${...}` references, never a literal value. Keep it that way. `.gitignore`
also excludes `.env*` and `.claude/settings.local.json` in case you use those instead.

### 3. (Optional) Add context files

Drop these into the `context/` folder if you have them:
- `context/hld.md` — High Level Design document
- `context/regression-scripts.md` — existing regression test names/descriptions

Plain text or markdown only. They are summarized to 500 words before use — original size doesn't matter.

### 4. Start Claude Code

```bash
cd tc-generator
claude
```

---

## Usage

### Generate test cases

```bash
# Basic — PBI IDs only
generate-test-cases --pbis 123,456,789

# With HLD context
generate-test-cases --pbis 123,456,789 --context hld

# With both context files
generate-test-cases --pbis 123,456,789 --context hld,regression
```

Output lands in `output/tc_YYYY-MM-DD.csv`. Open in Excel, review, edit if needed.

### Push reviewed file to ADO

```bash
push-test-cases --file output/tc_2024-01-10.csv
```

This creates Test Case work items in ADO and links each to its parent PBI.
You will be asked to confirm before anything is written.

---

## Output CSV format

The file matches ADO's native Test Case export, so it imports directly. One row per step; the
first row of each test case carries the fields, later rows only `Step #`, `Step Action` and
`Step Expected Result`. UTF-8 with BOM so Excel renders `•` and `—` correctly.

`ID, Work Item Type, Title, State, Assigned To, Priority, Tags, Area Path, Automated Status, Description, Test Data, Test Type, Step #, Step Action, Step Expected Result`

| Column | Description |
|---|---|
| Title | `[TC-123-NEG-01] ...` — the ID prefix links the test case to PBI 123 |
| Priority | 1–4 (1 = Critical) |
| Tags | Type + domain tags |
| Description | Preconditions, as `•` bullets |
| Test Data | Concrete data values |
| Test Type | Positive / Negative / Edge Case / Performance / Boundary |
| Step # / Step Action / Step Expected Result | One step per row |

Full rules live in `.claude/skills/ado-schema/SKILL.md`.

---

## TC type coverage per PBI

| Type | Minimum |
|---|---|
| Positive | 2 |
| Negative | 3 |
| Edge Case | 2 |
| Performance | 1 (API/DB PBIs only) |
| Boundary | 1 |

---

## Token efficiency design

- Context files loaded **only when `--context` flag is passed**
- Each subagent receives **only its own PBI's data** — not the full batch
- Context is pre-summarized to **500 words** before being passed to subagents
- ADO fetcher returns **slim JSON** (max 300 words per PBI, HTML stripped)
- Skills are **preloaded** into the subagent that needs them (`skills:` frontmatter) — the coordinator never pastes them into prompts

---

## Project structure

```
tc-generator/
├── CLAUDE.md                         ← coordinator brain (read this first)
├── .mcp.json                         ← ADO MCP server (reads ADO_ORG / ADO_PAT_B64 / ADO_PROJECT)
├── .claude/
│   ├── settings.json                 ← allowedTools
│   ├── agents/
│   │   ├── ado-fetcher.md            ← fetches PBI + Epic data from ADO
│   │   ├── tc-subagent.md            ← generates TCs for one PBI
│   │   └── push-agent.md             ← creates TC work items + links in ADO
│   └── skills/
│       ├── ado-schema/SKILL.md       ← ADO TC field format and naming rules
│       └── tc-generator/SKILL.md     ← TC generation rules and quality checklist
├── context/
│   ├── hld.md                        ← (optional) your HLD doc
│   └── regression-scripts.md         ← (optional) existing regression test list
└── output/
    └── tc_YYYY-MM-DD.csv             ← generated files land here
```

---

## YouTube series

This project is part of the **SDET Sanjay** Claude playlist https://youtube.com/playlist?list=PLTTtCOmLVLIw&si=Kxdqpx-GdUd9uFsU YouTube channel series on AI-powered test automation.
Subscribe for walkthroughs, architecture deep-dives, and live demos.
