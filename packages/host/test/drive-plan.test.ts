import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planWay } from "../src/drive.js";
import type { MapRoad } from "../src/mapfile.js";
import { AppMap, type Place } from "../src/places.js";
import { APP, BUILD, OLD_BUILD, road } from "./drive-helpers.js";

// AGENT-TOOLS 1.13 §18.4: which way a drive takes.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function mapWith(roads: MapRoad[], links: Record<string, string> = {}): AppMap {
  const dir = mkdtempSync(join(tmpdir(), "tapline-plan-"));
  dirs.push(dir);
  const map = new AppMap({ id: APP.id, name: APP.name, version: APP.version, build: APP.build }, { dir });
  for (const name of new Set(roads.flatMap((r) => [r.from, r.to]))) map.data().places[name] = { key: { route: [name] }, link: links[name] ?? null, last: "2026-11-12T10:00:00.000Z" };
  map.data().roads.push(...roads);
  return map;
}
const at = (name: string, link: string | null = null): Place => ({ name, key: { route: [name] }, link });
const any = { by: "any", tapsOnly: false } as const;
const names = (plan: ReturnType<typeof planWay>): string[] => ("error" in plan ? [plan.error] : plan.moves.map((m) => `${m.road.from}>${m.road.to}`));

describe("planWay", () => {
  it("a link beats roads under any", () => {
    const map = mapWith([road("a", "b", "x", "X")]);
    const plan = planWay(map, at("a"), at("b", "wayfare://b"), any);
    expect(plan).toMatchObject({ by: "link", cost: 1, proven: true });
    expect("error" in plan ? [] : plan.moves.map((m) => [m.viaLink, m.road.move.url])).toEqual([[true, "wayfare://b"]]);
  });

  it("a jump needs no known start", () => {
    const map = mapWith([road("a", "b", "x", "X")]);
    expect(planWay(map, null, at("b", "wayfare://b"), any)).toMatchObject({ by: "link" });
  });

  it("by taps never jumps, and a user's-eyes journey never jumps", () => {
    const map = mapWith([road("a", "b", "x", "X")]);
    expect(names(planWay(map, at("a"), at("b", "wayfare://b"), { by: "taps", tapsOnly: false }))).toEqual(["a>b"]);
    expect(names(planWay(map, at("a"), at("b", "wayfare://b"), { by: "any", tapsOnly: true }))).toEqual(["a>b"]);
  });

  it("by link with no link is no way, and by link never takes roads", () => {
    const map = mapWith([road("a", "b", "x", "X")]);
    expect(planWay(map, at("a"), at("b"), { by: "link", tapsOnly: false })).toEqual({ error: "no_way" });
    expect(planWay(map, at("a"), at("b", "wayfare://b"), { by: "link", tapsOnly: true })).toEqual({ error: "no_way" });
  });

  it("shortest chain wins; unproven count double", () => {
    const long = [road("a", "b", "1", "One"), road("b", "d", "2", "Two"), road("a", "d", "3", "Three", OLD_BUILD)];
    // Direct but unproven costs 2, the same as two proven moves: the fewer moves is not the rule, the cost is, and a tie is by recency (next test).
    const map = mapWith(long);
    const plan = planWay(map, at("a"), at("d"), any);
    expect("error" in plan ? 0 : plan.cost).toBe(2);
    const short = mapWith([road("a", "d", "3", "Three"), road("a", "b", "1", "One"), road("b", "d", "2", "Two")]);
    const direct = planWay(short, at("a"), at("d"), any);
    expect(names(direct)).toEqual(["a>d"]);
    // Two proven moves (2) beat one direct road that is unproven twice over? An unproven direct road costs 2; a chain with an unproven leg costs 3.
    const worse = mapWith([road("a", "d", "3", "Three", OLD_BUILD), road("a", "b", "1", "One", OLD_BUILD), road("b", "d", "2", "Two")]);
    expect(names(planWay(worse, at("a"), at("d"), any))).toEqual(["a>d"]);
    expect(planWay(worse, at("a"), at("d"), any)).toMatchObject({ cost: 2, proven: false });
    expect(planWay(map, at("a"), at("d"), any)).toMatchObject({ by: "taps" });
    expect(BUILD).not.toBe(OLD_BUILD);
  });

  it("a tie goes to the most recently used", () => {
    const older = road("a", "b", "old", "Old", BUILD, "2026-11-01T10:00:00.000Z");
    const newer = road("a", "b", "new", "New", BUILD, "2026-11-12T10:00:00.000Z");
    const map = mapWith([older, newer]);
    const plan = planWay(map, at("a"), at("b"), any);
    expect("error" in plan ? "" : plan.moves[0]?.road.move.target?.id).toBe("new");
  });

  it("unknown start with roads is unknown_start, and no way is no_way", () => {
    const map = mapWith([road("a", "b", "x", "X")]);
    expect(planWay(map, null, at("b"), any)).toEqual({ error: "unknown_start" });
    expect(planWay(map, at("b"), at("a"), any)).toEqual({ error: "no_way" });
  });

  it("a road by tapwright is not driven by Tapline unless both", () => {
    const theirs: MapRoad = { ...road("a", "b", "x", "X"), by: "tapwright" };
    expect(planWay(mapWith([theirs]), at("a"), at("b"), any)).toEqual({ error: "no_way" });
    expect(names(planWay(mapWith([{ ...theirs, by: "both" }]), at("a"), at("b"), any))).toEqual(["a>b"]);
  });
});
