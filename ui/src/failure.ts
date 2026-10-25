// Turns the raw reason a run failed into a plain title and next steps. Raw text stays available next to it.
export type ErrorHint = { title: string; steps: string[] };

type Rule = { pattern: RegExp; hint: ErrorHint };

// Order matters: the first rule that matches wins, so the more specific causes come first.
const RULES: Rule[] = [
  {
    pattern: /Could not start "|spawn .* ENOENT|is not recognized as an internal or external command|claude: command not found/i,
    hint: {
      title: "Claude Code could not be started",
      steps: [
        "In the terminal that runs this page, type `claude --version`. If that fails, install Claude Code first.",
        "If it works there but not here, start this page again from that same terminal.",
      ],
    },
  },
  {
    pattern: /\bis not a PBI\b|\bnot a (PBI|product backlog item)\b/i,
    hint: {
      title: "That work item is not a PBI",
      steps: [
        "Use the ids of PBIs: Product Backlog Item, User Story, Requirement or Issue, depending on your project's process.",
        "Open the item in Azure DevOps and check its type. Bugs, Tasks, Features and Epics are skipped.",
        "When you type several ids, the PBIs among them still get test cases; only the others are skipped.",
      ],
    },
  },
  {
    pattern: /CONNECT_TIMEOUT|timed out when connecting|MCP server .{0,60}(timed out|failed to connect|connection)|\bhad no tools\b|mcp__ado__\w+ .{0,40}(not available|unavailable)/i,
    hint: {
      title: "Couldn't connect to Azure DevOps",
      steps: [
        "Check that ADO_ORG, ADO_PROJECT and ADO_PAT_B64 are set in the terminal that started this page. The start-up lines say set or MISSING.",
        "Check that your personal access token has not expired and has Work Items and Test Management (read & write) scopes.",
        "Run `claude` once in the repo folder and approve the ado server if it asks. A background run cannot answer that question.",
        "The first start can be slow while the server downloads. Wait a minute and try again.",
      ],
    },
  },
  {
    pattern: /\b(401|403)\b|unauthori[sz]ed|forbidden|TF400813|access denied|token .{0,30}(expired|invalid)/i,
    hint: {
      title: "Azure DevOps refused the sign-in",
      steps: [
        "Your personal access token may have expired. Create a new one and set ADO_PAT_B64 again.",
        "Check its scopes: Work Items and Test Management, both read & write.",
        "Check that ADO_ORG and ADO_PROJECT match the names in your Azure DevOps address.",
      ],
    },
  },
  {
    pattern: /not logged in|please run \/login|invalid api key|authentication_error|oauth token has expired|credit balance is too low/i,
    hint: {
      title: "Claude Code is not signed in",
      steps: [
        "Run `claude` once in a terminal and sign in.",
        "If you use an API key, check that it is valid and that the account has credit.",
      ],
    },
  },
  {
    pattern: /TF401232|work item .{0,40}(does not exist|not found)|PBI \d+.{0,40}(not found|does not exist|fetch failed)/i,
    hint: {
      title: "A PBI could not be found",
      steps: [
        "Check the PBI ids you typed. They must exist in the project shown at the top of the page.",
        "Check that they are PBIs (or work items you can read) and not deleted.",
      ],
    },
  },
  {
    pattern: /Timed out after \d+ seconds/i,
    hint: {
      title: "The run took too long and was stopped",
      steps: [
        "Try fewer PBIs at a time.",
        "Open the full log to see which step was still running.",
      ],
    },
  },
];

export const explainFailure = (...texts: Array<string | undefined>): ErrorHint | null => {
  const combined = texts.filter((text): text is string => Boolean(text)).join("\n");
  return RULES.find((rule) => rule.pattern.test(combined))?.hint ?? null;
};
