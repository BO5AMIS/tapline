# Resuming Tapline

Tapline 1.9.0, "the Token Diet", is the last planned update for now (the owner's decision, 2026-11-19). This page is
for whoever picks Tapline up later: what is done, what is open, and where things live.

## What Tapline is, in one paragraph
An agent (Claude Code, Codex, any MCP client) sees and drives a React Native app on a real phone on the same Wi-Fi.
- **The SDK** (`react-native-tapline`) runs inside the app. It reads the React tree, calls handlers, and talks to a
  host on the computer over a WebSocket.
- **The host** (`tapline-host`) runs on the computer. It serves the agent's MCP tools, a live view in the browser, and
  a CLI.
- **The pairing token** lives only in `~/.tapline/token`.
- **Tapwright** is the sister project: it drives the whole phone through XCTest. It shares Tapline's tool contract and
  quality bar, but it is a separate repository and team.

## Where things live
| What | Where |
|---|---|
| Host: MCP server, tools, CLI | `packages/host/src`: `tools.ts` (every tool), `dispatch.ts` (the tool table), `mcp.ts`, `cli.ts`, `runtime.ts` |
| Tool descriptions and instructions | `packages/host/src/tool-text-data.ts` (generated from the shared TOOL-TEXT, word for word), `tool-text.ts`, `token-rules.ts` (1.9.0) |
| Map, `drive`, routes | `places.ts`, `drive.ts`, `routes.ts`, `known.ts` (the `Known:` line) |
| Hints (1.9.0) | `hints.ts`; added once, in `tools.ts`'s notes step |
| Explore, findings, bug report | `explore*.ts`, `findings.ts`, `bug*.ts`, `appfolder.ts` (one folder per app id) |
| Vault, grants, schedules, audit log | `accounts.ts`, `grants*.ts`, `schedule*.ts`, `auditlog.ts` |
| One-time codes (with Tapwright's daemon) | `otpclient.ts` |
| SDK | `packages/react-native/src`: `agent.ts` (pairing and connection), `client.ts`, `actions.ts` |
| Benchmark and scorecard | `bench/` (its own vitest suite) |
| The shared contract with Tapwright | `docs/AGENT-TOOLS.md`, `docs/QUALITY-BAR.md`, `docs/VIEWER-PROTOCOL.md`: byte-identical to Tapwright's copies, changed only by agreement of both projects, and checked by sha256 |
| Agent guides | `AGENTS.md` (the long one), `skills/tapline/SKILL.md` (installed by `tapline skill install`) |
| Release history and known limits | `CHANGELOG.md`: each release lists its known limits |

## How to work on it
- **Tests:** `npm ci`, then `npm run build` and `npm run typecheck`.
  - Host: `cd packages/host && npx vitest run`, about 3,200 tests. The real-DPAPI vault test can be slow under load;
    rerun it alone if it fails.
  - SDK: `cd packages/react-native && npx jest`, about 1,175 tests.
  - Bench: `cd bench && npx vitest run`.
  - A Windows run touches `packages/host/src/viewer-page.ts` (line endings only); restore it before committing.
- **Rules the project has kept:**
  - no TypeScript `any`;
  - every fix comes with a test that fails on the old code;
  - no personal data in tracked files (no IPs, machine or user names, private app names); scan the diff before every
    push;
  - secrets (the token, vault values, one-time codes) never reach an answer, a log, a report or a commit;
  - the default branch is protected: work on a feature branch, open a PR, and merge with a merge commit.
- **Releases:**
  1. A PR with the CHANGELOG section and both packages' versions bumped together.
  2. CI (`test.yml`, `native.yml`) passes, and the reviews are done (the owner capped AI review at 4 cycles a
     release, then fix and verify locally).
  3. Merge, then an annotated tag `vX.Y.Z` on the merge commit.
  4. `gh release create vX.Y.Z --verify-tag --notes-file <the CHANGELOG section>`.
  5. `publish.yml` publishes both npm packages with provenance; check that `npm view tapline-host` and
     `npm view react-native-tapline` show it as `latest`.
- **Versions** follow the owner's rule:
  - patch releases are for fixes;
  - `1.x.0` is for real features, each with a headline name;
  - `2.0.0` only by the owner's decision.

## What's open
- **Never run on a real phone:** 1.8.0 (explore and repair), 1.8.5 (bug report), 1.8.6's reload fix and
  dry-run-first order, and 1.9.0. They pass their tests against a fake app and host. A phone check on the demo app
  comes first when work resumes.
- **The 1.9.0 benchmark for Tapline:** the token benchmark ran for Tapwright only (21 sessions). The plan to run the
  same 21 sessions for Tapline, before and after 1.9.0, is written but not run. Until it runs, published numbers are
  Tapwright's only.
- **Spec questions waiting for both projects** (AGENT-TOOLS 1.16.3 proposals, kept with the joint drafts):
  - §29's bug count: both leads lean to "1 per source, the finding's own count as `occurrences`"; Tapline 1.8.6+
    still adds the finding's count;
  - Tapwright 1.7's readings: passcode, lock as kill switch, unlock limits, one-time code fields, drafts-only, token
    holders;
  - proposal 2 needs rewording after Tapwright's `unlock`.
- **Known limits by release:** see each CHANGELOG section. The main ones:
  - a bug both tools find is two bugs;
  - a journey's finding can't become a bug;
  - repair matches only the id stem and words;
  - `fixture:` marks aren't typed;
  - `explore` can't be scheduled;
  - the `Known:` line orders by when a place was last reached (the map keeps no use counts);
  - `Known:` leaves out places reached through saved routes, links that need a value, or policy words. In 1.9.0's
    review, each review cycle found another way a route could fail with no arguments.
    - The check that `drive` and `Known:` share is `planProblems` / `planRunnable` in `drive.ts`, plus `known.ts`.
    - Listing routes again needs a complete static check of a route's steps: the tools' own argument rules, the
      policy, and nested drives from the place reached so far.
- **Ideas not started:** Tapline as a device source in other agent tools, via an agent-device plugin (the other
  project's maintainers must agree before any PR).

## Where the record is
- Each feature's design and limits: the CHANGELOG section of its release.
- The joint decisions with Tapwright: the versions of `docs/AGENT-TOOLS.md` (the history line at its top lists every
  version and what it added).
- Pull requests #1 onwards: each one links its reviews and the fixes they led to.
