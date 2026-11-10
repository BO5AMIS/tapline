import { checkBeforeViewerTap, rethrowIfLeft } from "../guard.js";
import { checkUnchanged, expectState } from "../lab.js";
import type { ToolSession } from "../mcp.js";
import { ViewerClient } from "../viewer/client.js";
import { redactToken } from "../viewer/link.js";
import { getViewerLink, normalize } from "../viewer/suite.js";
import { R4_GRID, type GridCheck, type GridPoint } from "./checks.js";
import { markStep, runStateCall, type Env, type Outcome } from "./driver.js";
import { elementRect, fieldParts, parseStateFields, screenOf, withBusyRetry } from "./helpers.js";

/** The tap point in points for a grid entry, from a `look` answer; null when an element is missing. */
export function resolvePoint(text: string, point: GridPoint): { x: number; y: number } | null {
  if (point.kind === "center") {
    const r = elementRect(text, point.id);
    return r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : null;
  }
  const above = elementRect(text, point.above);
  const below = elementRect(text, point.below);
  const x = elementRect(text, point.xOf);
  if (!above || !below || !x) return null;
  return { x: x.x + x.w / 2, y: (above.y + above.h + below.y) / 2 };
}

const miss = (name: string, note: string): Outcome => ({ id: "R4", name, ok: false, note });

/**
 * R4: a person's tap in the viewer (`/ws` gesture, fractions of the screen) lands where a finger at
 * that point would. The tool reads the lab state; after each person tap it waits for the agent's
 * idle time (VIEWER-PROTOCOL: 3 s of the person's quiet) and retries once on `busy`.
 */
export async function runR4(env: Env, idleMs: number): Promise<Outcome[]> {
  let client: ViewerClient;
  try {
    const link = await getViewerLink(env.tool);
    env.token = link.token;
    client = await ViewerClient.connect(link);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return [miss("connect to the viewer", redactToken(msg, env.token).slice(0, 200))];
  }
  const out: Outcome[] = [];
  const tool: ToolSession = withBusyRetry(env.tool, idleMs, env.sleep);
  const inner: Env = { ...env, tool };
  try {
    for (const check of R4_GRID) {
      markStep(env, "R4", check.name);
      out.push(await runGridCheck(inner, client, check, idleMs));
    }
  } finally {
    await client.close();
  }
  return out;
}

async function runGridCheck(
  env: Env,
  client: ViewerClient,
  check: GridCheck,
  idleMs: number,
): Promise<Outcome> {
  const problems: string[] = [];
  if (check.inSheet) {
    const opened = await runStateCall(env, { tool: "tap", target: { id: "lab-open-sheet" }, expect: ["sheet=open"] });
    if (opened.missing.length > 0) return miss(check.name, "could not open the sheet with the tool");
  }
  try {
    const look = await env.tool.call("look", { screenshot: false });
    checkBeforeViewerTap(env.labApp, look.text);
    const screen = screenOf(look.text);
    const pt = resolvePoint(look.text, check.point);
    if (!screen || !pt) return miss(check.name, "look shows no geometry for the point");
    // The baseline comes from this very look (just before the tap), never from an earlier check.
    const baseline = fieldParts(parseStateFields(look.text));
    const f = normalize(pt, screen);
    client.tap(f.x, f.y);
    await env.sleep(idleMs);
    if (check.pressed !== undefined) {
      if (!(await expectState(env.tool, `pressed=${check.pressed}`, 3))) {
        problems.push(`pressed=${check.pressed} did not show within 3 s`);
      }
    } else {
      const bad = await checkUnchanged(
        env.tool,
        baseline,
        check.notPressed ? [`pressed=${check.notPressed}`] : [],
      );
      problems.push(...bad.map((b) => `state changed: ${b}`));
    }
  } catch (e) {
    rethrowIfLeft(e);
    problems.push(redactToken(e instanceof Error ? e.message : String(e), env.token).slice(0, 200));
  }
  if (check.inSheet) {
    const closed = await runStateCall(env, {
      tool: "tap",
      target: { id: "lab-sheet-close" },
      bring: null,
      expect: ["sheet=closed"],
    });
    if (closed.missing.length > 0) problems.push("could not close the sheet with the tool");
  }
  return { id: "R4", name: check.name, ok: problems.length === 0, ...(problems.length ? { note: problems.join("; ") } : {}) };
}
