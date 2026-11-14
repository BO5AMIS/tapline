import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { securityKeychain, type ProcRunner } from "../src/vault.js";

// PR 12 Codex cycle 4, finding 4 (AGENT-TOOLS 1.14.2 §20.2): a chunk whose text is all hex digits reads two ways (`security -w` prints
// non-text data as hex too). The reader decides each chunk's reading with the checksum as the oracle (up to 2^12 combinations, then it
// fails closed), and the writer never stores an ambiguous chunk. A fake `security`; every value is made up.

const entries = new Map<string, Buffer>();
const run: ProcRunner = async (_command, args, input) => {
  if (args[0] === "-i") {
    for (const line of input.split("\n")) {
      const hex = /-X ([0-9a-f]+)$/.exec(line)?.[1];
      const account = /-a "((?:[^"\\]|\\.)*)"/.exec(line)?.[1];
      if (hex !== undefined && account !== undefined) entries.set(account.replace(/\\(.)/g, "$1"), Buffer.from(hex, "hex"));
    }
    return { code: 0, stdout: "", stderr: "" };
  }
  const account = args[args.indexOf("-a") + 1] ?? "";
  if (args[0] === "delete-generic-password") return { code: entries.delete(account) ? 0 : 44, stdout: "", stderr: "" };
  const found = entries.get(account);
  if (found === undefined) return { code: 44, stdout: "", stderr: "not found" };
  const text = found.toString("utf8");
  return { code: 0, stdout: `${/^[\x20-\x7e]*$/.test(text) ? text : found.toString("hex")}\n`, stderr: "" };
};

const ACCOUNT = "/Users/me/vault-r11.json";
const put = (account: string, text: string): void => void entries.set(account, Buffer.from(text, "utf8"));

/** A vault stored by hand in chunks, the way an older writer could have: the manifest holds the checksum of the whole. */
function store(chunks: string[]): string {
  entries.clear();
  chunks.forEach((chunk, i) => put(`${ACCOUNT}#${i + 1}`, chunk));
  const whole = chunks.join("");
  put(ACCOUNT, JSON.stringify({ chunks: chunks.length, sha256: createHash("sha256").update(whole).digest("hex") }));
  return whole;
}

describe("the reader decides each chunk's reading by the checksum", () => {
  it("nine hex-looking chunks and a UTF-8 chunk reconstruct", async () => {
    const hexy = Array.from({ length: 9 }, (_, i) => `4${i}41`.repeat(3));
    const whole = store([...hexy, "tail-é-end"]);
    expect(await securityKeychain(run).read(ACCOUNT)).toBe(whole);
  });

  it("twelve ambiguous chunks reconstruct", async () => {
    const hexy = Array.from({ length: 11 }, (_, i) => `4${i % 10}41`.repeat(2));
    const whole = store([...hexy, "tail-é"]);
    expect(await securityKeychain(run).read(ACCOUNT)).toBe(whole);
  });

  it("more than twelve ambiguous chunks with no single reading fail closed with the incomplete message", async () => {
    const hexy = Array.from({ length: 13 }, () => "4141");
    store(hexy);
    put(ACCOUNT, JSON.stringify({ chunks: 13, sha256: "0".repeat(64) }));
    await expect(securityKeychain(run).read(ACCOUNT)).rejects.toThrow(/incomplete/);
  });

  it("a chunk whose hex doesn't decode to UTF-8 is read raw without a search", async () => {
    const whole = store(Array.from({ length: 20 }, () => "ffff"));
    expect(await securityKeychain(run).read(ACCOUNT)).toBe(whole);
  });
});

describe("the writer stores no ambiguous chunk", () => {
  it("a vault that holds long hex runs is cut so that no chunk is all hex digits of even length, and reads back", async () => {
    entries.clear();
    const json = JSON.stringify({ version: 2, vault: { k: { kind: "note", text: "41".repeat(9000) } } });
    await securityKeychain(run).write(ACCOUNT, json);
    const chunks = [...entries.keys()].filter((key) => key.includes("#"));
    expect(chunks.length).toBeGreaterThan(3);
    for (const key of chunks) {
      const text = (entries.get(key) as Buffer).toString("utf8");
      expect(/^[0-9a-fA-F]+$/.test(text) && text.length % 2 === 0, key).toBe(false);
    }
    expect(await securityKeychain(run).read(ACCOUNT)).toBe(json);
  });
});
