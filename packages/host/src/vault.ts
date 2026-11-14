import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * AGENT-TOOLS 1.14 §20.2: where the vault is kept. One format for both tools:
 * - Windows: `{"version": 2, "protected": "dpapi-user", "data": <base64 of CryptProtectData(UTF-8 JSON)>}`, current-user scope,
 *   with the fixed entropy below. Tapline calls DPAPI through PowerShell, Tapwright through ctypes; the blob is the same.
 * - macOS: a keychain generic password (service below, account = the file's real path), the same UTF-8 JSON as its data;
 *   the file holds `{"version": 2, "protected": "keychain"}`.
 * - Plain: `{"version": 2, "vault": {...}}`, for test data only.
 * Nothing here ever quotes a value: a failure says why in words.
 */

/** The optional entropy of the DPAPI blob (§20.2). */
export const DPAPI_ENTROPY = Buffer.from("tapline-tapwright-vault-v2", "utf8");
/** The keychain service (§20.2). */
export const KEYCHAIN_SERVICE = "tapline-tapwright-vault";

export type Protection = "dpapi-user" | "keychain";

/** What the person is told at every start while the vault is a plain file (§20.2). */
export function plainWarning(path: string): string {
  return `Note: the vault file ${path} is not encrypted; keep test data in it only.`;
}

export interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
/** Runs a program with text on its stdin. The text may hold a secret: it never goes on the command line. */
export type ProcRunner = (command: string, args: string[], input: string) => Promise<ProcResult>;

export const spawnRunner: ProcRunner = (command, args, input) =>
  new Promise((done) => {
    let out = "";
    let err = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      done({ code: null, stdout: "", stderr: "couldn't start" });
      return;
    }
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (err += chunk));
    child.on("error", () => done({ code: null, stdout: out, stderr: "couldn't start" }));
    child.on("close", (code) => done({ code, stdout: out, stderr: err }));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input);
  });

/** CryptProtectData and CryptUnprotectData, current-user scope, with the entropy given. */
export interface Dpapi {
  protect(data: Buffer, entropy: Buffer): Promise<Buffer>;
  unprotect(blob: Buffer, entropy: Buffer): Promise<Buffer>;
}

/**
 * The script only ever sees its input on stdin: the mode, the data and the entropy, one base64 line each. Nothing secret is
 * in the command line.
 */
const DPAPI_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Security",
  "$l = [Console]::In.ReadToEnd() -split '\\r?\\n'",
  "$d = [Convert]::FromBase64String($l[1])",
  "$e = [Convert]::FromBase64String($l[2])",
  "$s = [System.Security.Cryptography.DataProtectionScope]::CurrentUser",
  "if ($l[0] -eq 'protect') { $o = [System.Security.Cryptography.ProtectedData]::Protect($d, $e, $s) } else { $o = [System.Security.Cryptography.ProtectedData]::Unprotect($d, $e, $s) }",
  "[Convert]::ToBase64String($o)",
].join("; ");

export function powershellDpapi(run: ProcRunner = spawnRunner): Dpapi {
  const call = async (mode: "protect" | "unprotect", data: Buffer, entropy: Buffer): Promise<Buffer> => {
    const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", DPAPI_SCRIPT], `${mode}\n${data.toString("base64")}\n${entropy.toString("base64")}\n`);
    if (out.code !== 0 || out.stdout.trim() === "") {
      throw new Error(mode === "protect" ? "Windows couldn't protect the data" : "Windows couldn't decrypt it (it was protected for another user or another computer)");
    }
    return Buffer.from(out.stdout.trim(), "base64");
  };
  return { protect: (data, entropy) => call("protect", data, entropy), unprotect: (blob, entropy) => call("unprotect", blob, entropy) };
}

/** The macOS keychain's generic passwords under the vault's service. */
export interface Keychain {
  /** The stored UTF-8 JSON, or null when there is no entry for this account. */
  read(account: string): Promise<string | null>;
  write(account: string, json: string): Promise<void>;
}

function securityQuote(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * `security -i` reads at most 4095 bytes per input line, and a line is the whole command with its hex data: about 1.9 KB of vault
 * JSON at most. Anything that fits is stored as one entry, the form the spec fixes (§20.2). A larger vault is stored in chunks
 * under other accounts and a small manifest under the file's own account (a Tapline layout: Tapwright reads a vault that fits in
 * one entry until the spec says how it reads this).
 */
const LINE_BUDGET = 3900;
const MIN_CHUNK = 64;
const CHUNK_TEXT = "c:";
const MANIFEST_KEY = "tapline_chunks";

interface Manifest {
  id: string;
  n: number;
  bytes: number;
}

function manifestOf(text: string | null): Manifest | null {
  if (text === null || !text.startsWith(`{"${MANIFEST_KEY}":`)) return null;
  try {
    const found = (JSON.parse(text) as Record<string, unknown>)[MANIFEST_KEY];
    if (typeof found !== "object" || found === null) return null;
    const { id, n, bytes } = found as { id?: unknown; n?: unknown; bytes?: unknown };
    return typeof id === "string" && /^[0-9a-f]{12}$/.test(id) && typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 100_000 && typeof bytes === "number" ? { id, n, bytes } : null;
  } catch {
    return null;
  }
}

const chunkAccount = (account: string, id: string, index: number): string => `${account}#${id}.${index}`;

/** Through the `security` CLI. The data goes in on stdin (`security -i`), so it is never in the process list. */
export function securityKeychain(run: ProcRunner = spawnRunner): Keychain {
  /** The stored text of one entry, or null when there is none. `security -w` prints data that isn't plain text as hex. */
  const readText = async (account: string): Promise<string | null> => {
    const out = await run("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"], "");
    if (out.code !== 0) return null;
    const text = out.stdout.replace(/\r?\n$/, "");
    if (text === "") return null;
    return text.startsWith("{") || text.startsWith(CHUNK_TEXT) ? text : /^[0-9a-fA-F]+$/.test(text) ? Buffer.from(text, "hex").toString("utf8") : null;
  };
  const read = async (account: string): Promise<string | null> => {
    const text = await readText(account);
    const manifest = manifestOf(text);
    if (manifest === null) return text;
    const parts: Buffer[] = [];
    for (let i = 0; i < manifest.n; i++) {
      const chunk = await readText(chunkAccount(account, manifest.id, i));
      if (chunk === null || !chunk.startsWith(CHUNK_TEXT) || !/^[0-9a-f]*$/.test(chunk.slice(CHUNK_TEXT.length))) return null;
      parts.push(Buffer.from(chunk.slice(CHUNK_TEXT.length), "hex"));
    }
    const whole = Buffer.concat(parts);
    return whole.length === manifest.bytes ? whole.toString("utf8") : null;
  };
  const addLine = (account: string, data: Buffer): string => `add-generic-password -U -s ${securityQuote(KEYCHAIN_SERVICE)} -a ${securityQuote(account)} -X ${data.toString("hex")}`;
  /** Stores one entry. The interactive mode doesn't always set the exit code, so the caller reads back what mattered. */
  const store = async (account: string, data: Buffer): Promise<void> => {
    await run("security", ["-i"], `${addLine(account, data)}\n`);
  };
  const drop = async (account: string, manifest: Manifest | null): Promise<void> => {
    if (manifest === null) return;
    for (let i = 0; i < manifest.n; i++) await run("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", chunkAccount(account, manifest.id, i)], "").catch(() => undefined);
  };
  return {
    read,
    async write(account, json) {
      const previous = manifestOf(await readText(account));
      const data = Buffer.from(json, "utf8");
      if (Buffer.byteLength(addLine(account, data)) <= LINE_BUDGET) {
        await store(account, data);
        if ((await read(account)) !== json) throw new Error("the keychain didn't keep the entry");
        await drop(account, previous);
        return;
      }
      const id = randomBytes(6).toString("hex");
      const room = Math.floor((LINE_BUDGET - Buffer.byteLength(addLine(chunkAccount(account, id, 999_999), Buffer.alloc(0)))) / 2);
      const size = Math.floor((room - CHUNK_TEXT.length) / 2);
      if (size < MIN_CHUNK) throw new Error("the vault file's path is too long to store in the macOS keychain");
      const count = Math.ceil(data.length / size);
      const fresh: Manifest = { id, n: count, bytes: data.length };
      // The chunks first, under a fresh id, then the manifest: until the manifest is replaced the old vault is intact.
      for (let i = 0; i < count; i++) {
        const text = `${CHUNK_TEXT}${data.subarray(i * size, (i + 1) * size).toString("hex")}`;
        await store(chunkAccount(account, id, i), Buffer.from(text, "utf8"));
        // a chunk that wasn't kept stops the write before the manifest points to it
        if ((await readText(chunkAccount(account, id, i))) !== text) {
          await drop(account, { id, n: i + 1, bytes: 0 });
          throw new Error("the keychain didn't keep the entry");
        }
      }
      await store(account, Buffer.from(JSON.stringify({ [MANIFEST_KEY]: fresh }), "utf8"));
      if ((await read(account)) !== json) {
        // the manifest wasn't kept: the old entry still holds the old vault, and the new chunks are of no use
        await drop(account, fresh);
        throw new Error("the keychain didn't keep the entry");
      }
      await drop(account, previous);
    },
  };
}

export interface VaultDeps {
  platform: NodeJS.Platform;
  dpapi: Dpapi;
  keychain: Keychain;
}

export function realVaultDeps(): VaultDeps {
  return { platform: process.platform, dpapi: powershellDpapi(), keychain: securityKeychain() };
}

/** The protection this system has, if any. */
export function protectionOf(platform: NodeJS.Platform): Protection | null {
  return platform === "win32" ? "dpapi-user" : platform === "darwin" ? "keychain" : null;
}

export function realPathOf(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

/** A file's top level, read for how it is kept (protected or plain). `null` when it isn't an object. */
export function peekFile(text: string): { protected?: string; data?: string } | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const top = parsed as { protected?: unknown; data?: unknown };
    return { ...(typeof top.protected === "string" ? { protected: top.protected } : {}), ...(typeof top.data === "string" ? { data: top.data } : {}) };
  } catch {
    return null;
  }
}

export class VaultOpenError extends Error {}

/** The decrypted JSON text of a protected file. Throws `VaultOpenError` with the reason (never a value). */
export async function openProtected(path: string, file: { protected?: string; data?: string }, deps: VaultDeps): Promise<string> {
  if (file.protected === "dpapi-user") {
    if (deps.platform !== "win32") throw new VaultOpenError("the file is protected with Windows DPAPI and can only be opened on Windows");
    if (file.data === undefined || file.data === "") throw new VaultOpenError("the protected file holds no data");
    try {
      return (await deps.dpapi.unprotect(Buffer.from(file.data, "base64"), DPAPI_ENTROPY)).toString("utf8");
    } catch (error) {
      throw new VaultOpenError(error instanceof Error ? error.message : "Windows couldn't decrypt it");
    }
  }
  if (file.protected === "keychain") {
    if (deps.platform !== "darwin") throw new VaultOpenError("the file is protected with the macOS keychain and can only be opened on a Mac");
    const found = await deps.keychain.read(realPathOf(path)).catch(() => null);
    if (found === null) throw new VaultOpenError("the keychain has no entry for this file's path (the file was moved, or it was protected by another user)");
    return found;
  }
  throw new VaultOpenError(`the file says it is protected as "${file.protected ?? ""}", which this Tapline doesn't know`);
}

/**
 * `tapline vault protect FILE` (§20.2): reads a plain vault file and writes it in this system's protected form. A version 1
 * file becomes version 2. Other top-level keys (Tapwright's `otp`) travel inside the protected data untouched.
 */
export async function protectVaultFile(path: string, deps: VaultDeps = realVaultDeps()): Promise<{ ok: true; how: Protection } | { ok: false; message: string }> {
  const file = resolve(path);
  if (!existsSync(file)) return { ok: false, message: `the vault file ${file} doesn't exist.` };
  const how = protectionOf(deps.platform);
  if (how === null) return { ok: false, message: "this system has no protection for the vault (Windows DPAPI or the macOS keychain); the file stays plain, for test data only." };
  const real = realPathOf(file);
  let text: string;
  try {
    text = readFileSync(real, "utf8");
  } catch {
    return { ok: false, message: `couldn't read ${file}.` };
  }
  const peek = peekFile(text);
  if (peek?.protected !== undefined) return { ok: false, message: `the vault file ${file} is already protected.` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, message: `the vault file ${file} isn't valid JSON.` };
  }
  const top = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  if (top === null) return { ok: false, message: `the vault file ${file} isn't a vault.` };
  let payload: Record<string, unknown>;
  if (top["version"] === 2 && typeof top["vault"] === "object" && top["vault"] !== null) {
    payload = top;
  } else if (top["version"] === 1 && typeof top["accounts"] === "object" && top["accounts"] !== null) {
    const { accounts, version: _version, ...rest } = top;
    const vault: Record<string, unknown> = {};
    for (const [name, entry] of Object.entries(accounts as Record<string, unknown>)) {
      const fields = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
      const onlyPasscode = fields["passcode"] !== undefined && fields["username"] === undefined && fields["password"] === undefined;
      vault[name] = { kind: onlyPasscode ? "phone" : "account", ...fields };
    }
    payload = { version: 2, vault, ...rest };
  } else {
    return { ok: false, message: `the vault file ${file} isn't a version 1 or 2 vault.` };
  }
  const json = JSON.stringify(payload);
  try {
    let out: string;
    if (how === "dpapi-user") {
      const blob = await deps.dpapi.protect(Buffer.from(json, "utf8"), DPAPI_ENTROPY);
      out = JSON.stringify({ version: 2, protected: "dpapi-user", data: blob.toString("base64") });
    } else {
      await deps.keychain.write(real, json);
      out = JSON.stringify({ version: 2, protected: "keychain" });
    }
    // Written beside the file and moved in, so a failure never leaves half a file.
    const temp = join(dirname(real), `.${Date.now().toString(36)}.vault.tmp`);
    writeFileSync(temp, `${out}\n`, { mode: 0o600 });
    renameSync(temp, real);
  } catch (error) {
    return { ok: false, message: `couldn't protect the file: ${error instanceof Error ? error.message : "an error"}.` };
  }
  return { ok: true, how };
}

/** The words `tapline vault protect` answers. */
export function protectedLine(path: string, how: Protection): string {
  return how === "dpapi-user"
    ? `Protected ${resolve(path)} with Windows DPAPI (current user). Tapwright reads it too.`
    : `Protected ${resolve(path)} in the macOS keychain (service ${KEYCHAIN_SERVICE}; the entry belongs to this path, so a moved file needs protecting again).`;
}
