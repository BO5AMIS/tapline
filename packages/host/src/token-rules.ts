// AGENT-TOOLS 1.17 §30.1: the token rules that begin the MCP instructions, word for word in both tools. Each tool fills in
// its own replay call; Tapline's is `drive {"to": ...}` on the map. `--no-hints` leaves the block out (§30.4).

const REPLAY = '`drive {"to": ...}`';

export const TOKEN_RULES = [
  "Working well with this tool (fewer calls, fewer tokens):",
  "- Read each answer: it says what changed. Don't look again just to check.",
  "- When you know the next steps, send them as one `run`, with an `expect` on the steps that matter.",
  "- Target by id when there is one.",
  "- Ask for a screenshot only to judge how something looks (`screenshot: false` on a `look` that only reads); the text",
  "  answer is enough to act.",
  `- \`Known:\` lists screens reachable in one call (${REPLAY}). Use it instead of tapping your way there.`,
  "- On a long or unknown task, hand the driving to one small, fast agent and check its result; never two drivers.",
  "- A bug report is `bug_report`, not a file you write.",
].join("\n");
