# Web UI quick start

A local web page for the tc-generator pipeline: enter PBI ids, watch the run, review and edit the
test cases, then push them to Azure DevOps. It drives the same slash commands as the terminal
(`claude -p "/generate-test-cases ..."`), so there is one code path. Back to the
[main README](../README.md).

## 1. Prerequisites

| Need | Notes |
|---|---|
| Node.js 18+ and pnpm | The page runs on Node; the ADO MCP server runs through `npx` |
| [Claude Code](https://claude.ai/code), installed and signed in | The page starts it in the background. If `claude` does not work in your terminal, neither will the page |
| Azure DevOps access + a PAT | Scopes: **Work Items** (Read & write) and **Test Management** (Read & write) |
| Three environment variables | See step 2 |

## 2. Set the environment variables

Set them in the **same terminal** that starts the page. Nothing secret is stored in the repo.

| Variable | Value |
|---|---|
| `ADO_ORG` | Organization name, from `https://dev.azure.com/<ADO_ORG>` |
| `ADO_PROJECT` | Project name, from `https://dev.azure.com/<ADO_ORG>/<ADO_PROJECT>` |
| `ADO_PAT_B64` | Base64 of `<email>:<pat>` (the pair, not the bare PAT) |

PowerShell:

```powershell
$env:ADO_ORG = "your-org"
$env:ADO_PROJECT = "your-project"
$env:ADO_PAT_B64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("you@company.com:YOUR_PAT"))
```

Git Bash / bash / zsh:

```bash
export ADO_ORG="your-org"
export ADO_PROJECT="your-project"
export ADO_PAT_B64="$(printf '%s' 'you@company.com:YOUR_PAT' | base64 | tr -d '\n')"
```

How to create the PAT is in the [README, Setup](../README.md#setup).

## 3. Start it

```bash
cd ui
pnpm install      # first time only
pnpm dev          # http://127.0.0.1:3210
```

The terminal prints the address and whether `ADO_PAT_B64`, `ADO_ORG` and `ADO_PROJECT` are set. Open
**http://127.0.0.1:3210**. To use another port, set `UI_PORT` first.

## 4. Use it

1. **Generate.** Type PBI ids (comma separated, e.g. `2, 3`). Optionally pick extra context: the repo's
   file, an uploaded document, or a URL. It is used for this run only, and nothing is loaded unless you
   choose it. Click **Generate test cases**.
2. **Watch.** The progress bar counts the steps and shows elapsed time; **Run log** shows the raw events.
   Only one run at a time. **Cancel run** stops a stuck one.
3. **Review.** Filter by type, PBI, or text. Download the ADO CSV.
4. **Edited the CSV?** Fix it in Excel (save as *CSV UTF-8*, keep each title starting with
   `[TC-<PBI id>-...]`), upload it back, and check **What changed**. The upload is pushed instead of the
   original; **Remove upload** goes back to the original.
5. **Push.** Click **Push to Azure DevOps...**, type the project name exactly, then **Push test cases**.
   The result shows created, linked and failed. Pushing creates real work items, so try a test project
   first.

## 5. Safety

- Binds to `127.0.0.1` only, rejects other Host/Origin headers, and never sends the PAT to the browser.
- A push needs the typed project name, and the server re-checks it and the test case count.
- A URL context source cannot point at this machine.

## 6. Tests

```bash
pnpm test    # unit + API tests, no network
pnpm e2e     # Playwright against a fake `claude` that replays a recorded run (no ADO calls, no tokens)
```

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Startup shows `MISSING` for a variable | It was not set in the terminal that runs `pnpm dev` |
| Run fails straight away | `claude` is not installed or not signed in; run `claude` once in a terminal |
| PBI fetch fails | `ado` MCP server did not connect (check the PAT scopes, expiry and `ADO_ORG`) |
| Port already in use | Set `UI_PORT` to a free port |
