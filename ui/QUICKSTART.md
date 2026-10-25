# Web UI quick start

A local web page for the tc-generator pipeline: enter PBI ids, watch the run, review and edit the
test cases, then push them to Azure DevOps. It drives the same slash commands as the terminal
(`claude -p "/generate-test-cases ..."`), so there is one code path. Back to the
[main README](../README.md).

## 1. Prerequisites

| Need | Notes |
|---|---|
| Node.js 20+ | The page and its tests run on Node; the ADO MCP server runs through `npx`. Check with `node --version` |
| [pnpm](https://pnpm.io/installation) | Every command here uses it. Install with `npm install -g pnpm` (or `corepack enable`), then check with `pnpm --version` |
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

## 3. Check Claude Code (one time)

The page does not generate anything itself. It starts Claude Code in the background and runs the
repo's slash commands (see [How the page works with Claude Code](#6-how-the-page-works-with-claude-code)).
So Claude Code must work from the terminal that starts the page:

1. **`claude` is on the PATH.** Run `claude --version`. If the command is not found, install Claude Code
   first (see the [README, Prerequisites](../README.md#prerequisites)).
2. **You are signed in.** Run `claude` once, interactively. If it asks you to log in, sign in first.
3. **Approve the project once.** In the **repo root** (the folder that contains `.mcp.json`), run `claude`
   interactively and accept the prompts to trust the folder and to use the `ado` MCP server. A background
   run cannot answer those prompts, so if they were never approved, the first run in a new clone fails.

Run these in the same kind of terminal you will use for `pnpm dev`, with the environment variables from
step 2 set, because the `ado` server reads them.

## 4. Start it

```bash
cd ui
pnpm install      # first time only
pnpm dev          # http://127.0.0.1:3210
```

The terminal prints the address and whether `ADO_PAT_B64`, `ADO_ORG` and `ADO_PROJECT` are set. Open
**http://127.0.0.1:3210**. To use another port, set `UI_PORT` first.

## 5. Use it

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

## 6. How the page works with Claude Code

You can run the pipeline two ways, and both use the **same commands, agents and skills**:

| | Interactive Claude Code (terminal) | This web page |
|---|---|---|
| How you start it | Run `claude` in the repo, then type `/generate-test-cases --pbis 2,3` | Type the PBI ids and click **Generate test cases** |
| What runs | The slash command in `.claude/commands`, which follows `CLAUDE.md` | The same slash command, started as `claude -p "/generate-test-cases --pbis 2,3 ..."` |
| Who watches | You, in the terminal | The page, from Claude's streamed output (`--output-format stream-json`) |
| Questions to you | Claude can ask, e.g. `Confirm? (yes/no)` before a push | None. A background run has no one to answer |

What happens when you click **Generate test cases**:

1. The page's local server runs `claude -p` from the repo folder, so Claude Code reads `CLAUDE.md`,
   `.claude/agents` and `.mcp.json`.
2. Claude fetches the PBIs through the `ado` MCP server, starts one `tc-subagent` per PBI in parallel,
   merges the results and writes `output/tc_YYYY-MM-DD.csv`.
3. The server turns Claude's streamed events into the progress bar, step count and **Run log**, and reads
   the CSV for the **Review** table. **Cancel run** stops the Claude process.
4. **Push** is the same idea: the server runs `/push-test-cases --file ... --yes`. The `--yes` flag skips
   the terminal's `Confirm? (yes/no)` question, because the page has already made you type the project
   name and the server re-checks it.

Because the page runs Claude without a person at the keyboard, two things follow:

- Anything that needs a one-time answer (trusting the folder, approving the `ado` server) must be done
  once in interactive Claude Code first. That is step 3.
- The page and an interactive session do the same work. If something fails in the page, you can reproduce
  it by running the same slash command in an interactive `claude` session and reading the messages there.

## 7. Safety

- Binds to `127.0.0.1` only, rejects other Host/Origin headers, and never sends the PAT to the browser.
- A push needs the typed project name, and the server re-checks it and the test case count.
- A URL context source cannot point at this machine.

## 8. Tests

```bash
pnpm test    # unit + API tests, no network
pnpm e2e     # Playwright against a fake `claude` that replays a recorded run (no ADO calls, no tokens)
```

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Startup shows `MISSING` for a variable | It was not set in the terminal that runs `pnpm dev` |
| Run fails straight away | `claude` is not installed or not signed in; run `claude` once in a terminal |
| First run in a new clone fails or hangs on the ADO step | The folder or the `ado` MCP server was never approved; do step 3 in interactive `claude` |
| PBI fetch fails | `ado` MCP server did not connect (check the PAT scopes, expiry and `ADO_ORG`) |
| Port already in use | Set `UI_PORT` to a free port |
