import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AuditEntry, AuditSink } from "../src/auditlog.js";
import type { MapFile } from "../src/mapfile.js";
import type { PolicyFile } from "../src/policy.js";
import type { TaplineHost } from "../src/server.js";
import type { ToolsOptions } from "../src/tools.js";
import { APP, BUILD } from "./drive-helpers.js";
import { setupExplore, type ExWorld, type ExploreSetup } from "./explore-helpers.js";
import type { FakeApp } from "./helpers.js";

// A fake app whose UI changed between the recording and the replay (AGENT-TOOLS 1.15 §26): a script file, an audit sink, the maps.

export { APP, BUILD };

export const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

export type AuditLine = Omit<AuditEntry, "t" | "tool">;

export interface RepairRig {
  s: ExploreSetup;
  scriptsDir: string;
  lines: AuditLine[];
  /** Writes a script (shared format, version 1 unless `extra` says another) and answers its path. */
  script: (name: string, steps: Array<Record<string, unknown>>, extra?: Record<string, unknown>) => string;
  /** The files next to the scripts. */
  files: () => string[];
  read: (name: string) => string;
}

export interface RigOptions {
  world?: (world: ExWorld) => void;
  map?: MapFile;
  policy?: PolicyFile;
  /** The audit log can't be written. */
  auditFails?: boolean;
  /** No audit sink at all. */
  noAudit?: boolean;
  /** More tools options (a folder for reference pictures, say). */
  tools?: Partial<ToolsOptions>;
}

export async function repairRig(hosts: TaplineHost[], apps: FakeApp[], dirs: string[], options: RigOptions = {}): Promise<RepairRig> {
  const scriptsDir = mkdtempSync(join(tmpdir(), "tapline-repair-scripts-"));
  dirs.push(scriptsDir);
  const lines: AuditLine[] = [];
  const audit: AuditSink = {
    write: (entry) => {
      if (options.auditFails === true) return false;
      lines.push(entry);
      return true;
    },
  };
  const s = await setupExplore(hosts, apps, dirs, {
    ...(options.world !== undefined ? { world: options.world } : {}),
    map: options.map ?? mapWith({ home: ["home"], settings: ["settings"], language: ["settings", "language"], trips: ["trips"], trips_id: ["trips", "[id]"], form: ["form"] }, []),
    ...(options.policy !== undefined ? { policy: options.policy } : {}),
    tools: { scriptsDir, ...(options.noAudit === true ? {} : { audit }), ...options.tools },
  });
  return {
    s,
    scriptsDir,
    lines,
    script: (name, steps, extra = {}) => {
      const path = join(scriptsDir, `${name}.json`);
      writeFileSync(path, `${JSON.stringify({ format: "agent-tools-script", version: 1, name, app: APP.id, fresh: false, steps, ...extra }, null, 2)}\n`);
      return path;
    },
    files: () => readdirSync(scriptsDir).sort(),
    read: (name) => readFileSync(join(scriptsDir, name), "utf8"),
  };
}

/** A map the drive tests' way: the places and roads given, proven for the build the fake app reports. */
export function mapWith(places: Record<string, string[]>, roads: Array<{ from: string; to: string; id: string; text: string }>): MapFile {
  return {
    format: "agent-tools-map",
    version: 1,
    app: APP.id,
    places: Object.fromEntries(Object.entries(places).map(([name, route]) => [name, { key: { route }, link: null, last: "2026-11-12T10:00:00.000Z" }])),
    roads: roads.map((r) => ({
      from: r.from,
      to: r.to,
      move: { tool: "tap", target: { id: r.id } },
      names: { id: r.id, label: r.text, text: r.text },
      by: "tapline",
      seen: 2,
      failed: 0,
      ms: 500,
      last: "2026-11-12T10:00:00.000Z",
      build: BUILD,
    })),
    routes: {},
    reflexes: [],
  };
}
