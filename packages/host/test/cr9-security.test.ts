import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { accountStore } from "../src/accounts.js";
import { hostProof } from "../src/api.js";
import { loadMap, type MapFile, type MapRoad } from "../src/mapfile.js";
import { cheapestWay, reflexSchema, runMap, type MapContext } from "../src/mapcmd.js";
import { AppMap } from "../src/places.js";
import { linkWords, matchWord } from "../src/policy.js";

// PR 9 review (security findings): scrubbing, links, the search for a way, and the host's proof.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const LAST = "2026-11-12T10:00:00.000Z";
function road(from: string, to: string, id: string): MapRoad {
  return { from, to, move: { tool: "tap", target: { id } }, names: { id }, by: "tapline", seen: 2, failed: 0, ms: 500, last: LAST, build: "1.0.0 (1)" };
}

describe("accounts: form-encoded values", () => {
  it("scrubs a password that URLSearchParams encodes differently from encodeURIComponent", () => {
    const store = accountStore({ version: 1, accounts: { t: { username: "u@example.com", password: "abc~xyz!(*)'" } } });
    const form = new URLSearchParams({ password: "abc~xyz!(*)'" }).toString();
    expect(form).toContain("abc%7Exyz");
    expect(store.redact(`POST ${form}`)).toBe("POST password=<t's password>");
  });
});

describe("policy: percent-encoded link paths", () => {
  it("decodes the path before the words are read", () => {
    expect(linkWords("wayfare://account/%44elete")).toBe("account Delete");
    expect(matchWord(["delete"], { text: linkWords("wayfare://account/%64%65lete") })).toBe("delete");
    expect(matchWord(["delete"], { text: linkWords("wayfare://account/%2564elete") })).toBe("delete");
  });

  it("decodes only after the query is cut (%3F is not a query)", () => {
    expect(linkWords("wayfare://account%3Fdelete")).toBe("account?delete");
    expect(linkWords("wayfare://account/ok?x=%44elete")).toBe("account ok");
  });

  it("a reflex that opens an encoded delete link is refused", async () => {
    const ctx = fixtureContext();
    const reflex = reflexSchema.parse({ name: "r", when: { text: "x" }, do: { tool: "open_url", url: "wayfare://account/%44elete" } });
    const out = await runMap({ reflex }, { ...ctx, lists: { confirm: ["Delete"], block: [] } });
    expect(out.text).toContain("not_allowed");
  });
});

function fixtureContext(): MapContext {
  const dir = mkdtempSync(join(tmpdir(), "tapline-cr9-"));
  dirs.push(dir);
  const app = { id: "com.example.wayfare", name: "Wayfare" };
  const folder = join(dir, app.id);
  mkdirSync(folder, { recursive: true });
  const file: MapFile = {
    format: "agent-tools-map",
    version: 1,
    app: app.id,
    places: { home: { key: { route: ["index"] }, link: null, last: LAST }, trips_id: { key: { route: ["trips", "[id]"] }, link: null, last: LAST } },
    roads: [],
    routes: {},
    reflexes: [],
  };
  writeFileSync(join(folder, "map.json"), JSON.stringify(file));
  const map = new AppMap({ ...app, version: "1.0.0", build: "1" }, { dir: folder });
  dirs.push(folder);
  return {
    map,
    app,
    here: async () => ({ name: "home", key: { route: ["index"] }, link: null }),
    known: async () => ({ source: "none", places: [] }),
    lists: { confirm: [], block: [] },
    accounts: [],
  } as unknown as MapContext;
}

describe("map link: encoded values", () => {
  it("refuses a link whose encoded segment is an id, and doesn't echo it", async () => {
    const ctx = fixtureContext();
    const out = await runMap({ link: "wayfare://trips/%34%38%32%39%31%33", place: "trips_id" }, ctx);
    expect(out.error).toBe(true);
    expect(out.text).toContain("wayfare://trips/[id]");
    expect(out.text).not.toContain("%34");
    expect(ctx.map.data().places["trips_id"]?.link).toBeNull();
  });

  it("refuses an encoded query or fragment", async () => {
    const ctx = fixtureContext();
    expect((await runMap({ link: "wayfare://trips/x%3Ftoken=1", place: "trips_id" }, ctx)).error).toBe(true);
    expect((await runMap({ link: "wayfare://trips/[id]", place: "trips_id" }, ctx)).error).toBe(false);
  });
});

describe("cheapestWay: no budget cut-off", () => {
  it("finds a direct road after a tangled group that exhausts a small search", () => {
    const group = Array.from({ length: 10 }, (_, i) => `g${i}`);
    const roads: MapRoad[] = [road("home", "g0", "to-g0")];
    for (const a of group) for (const b of group) if (a !== b) roads.push(road(a, b, `${a}-${b}`));
    roads.push(road("home", "target", "direct"));
    const way = cheapestWay(roads, "home", "target", () => true);
    expect(way?.map((leg) => leg.to)).toEqual(["target"]);
  });
});

describe("forget: a removal the merge rejects", () => {
  it("says so when the file holds newer evidence for the place", async () => {
    const ctx = fixtureContext();
    const folder = ctx.map.folder();
    // Another tool saved the place after this one last saw it.
    const onDisk = loadMap(folder, "com.example.wayfare").map;
    const newer = { ...onDisk, places: { ...onDisk.places, home: { ...onDisk.places["home"]!, last: "2099-01-01T00:00:00.000Z" } } };
    writeFileSync(join(folder, "map.json"), JSON.stringify(newer));
    const out = await runMap({ forget: "home" }, ctx);
    expect(out.error).toBe(true);
    expect(out.text).toContain("was kept");
  });
});

describe("hostProof", () => {
  it("depends on the token and the challenge", () => {
    expect(hostProof("t", "aa", "127.0.0.1", 7210)).toMatch(/^[0-9a-f]{64}$/);
    expect(hostProof("t", "aa", "127.0.0.1", 7210)).not.toBe(hostProof("u", "aa", "127.0.0.1", 7210));
    expect(hostProof("t", "aa", "127.0.0.1", 7210)).not.toBe(hostProof("t", "ab", "127.0.0.1", 7210));
  });
});
