import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createOtpService, fetchOtp, noCodeMessage, otpReference, proofFor, OtpCodes, type OtpDeps } from "../src/otpclient.js";
import { FAKE_CODE, FAKE_TOKEN, startFakeTapwright, tapwrightHome, type FakeDaemon } from "./fake-tapwright.js";

// AGENT-TOOLS 1.14 §18.11, §20.4: the one-time code client against a fake Tapwright daemon (a real loopback server). Every token is made up.

const APP = "com.example.demo";
const CHALLENGE = Buffer.alloc(32, 7);

const daemons: FakeDaemon[] = [];
const homes: Array<ReturnType<typeof tapwrightHome>> = [];
afterEach(async () => {
  await Promise.all(daemons.splice(0).map((d) => d.close()));
  for (const home of homes.splice(0)) home.cleanup();
});

async function setup(behavior: Parameters<typeof startFakeTapwright>[0] = {}, serve?: { token?: string; port?: number }) {
  const daemon = await startFakeTapwright(behavior);
  daemons.push(daemon);
  const home = tapwrightHome({ port: serve?.port ?? daemon.port, token: serve?.token ?? FAKE_TOKEN, pid: 1 });
  homes.push(home);
  const deps: OtpDeps = { home: home.dir, random: () => CHALLENGE, settleMs: 10, timeoutMs: 3000 };
  return { daemon, home, deps };
}

describe("the references", () => {
  it("`${otp.<app>}` is whole-text only and takes an app id", () => {
    expect(otpReference("${otp.com.example.demo}")).toBe(APP);
    expect(otpReference("${otp.my-app_1}")).toBe("my-app_1");
    expect(otpReference("code ${otp.com.example.demo}")).toBeNull();
    expect(otpReference("${otp.com.example.demo} ")).toBeNull();
    expect(otpReference("${otp.}")).toBeNull();
    expect(otpReference("${vault.home.street}")).toBeNull();
  });
});

describe("the proof", () => {
  it("is HMAC-SHA256 over the label, the raw challenge, the address and the port, NUL between", () => {
    const expected = proofFor(FAKE_TOKEN, CHALLENGE, "127.0.0.1", 4242);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    expect(proofFor(FAKE_TOKEN, CHALLENGE, "127.0.0.1", 4243)).not.toBe(expected);
    expect(proofFor(FAKE_TOKEN, CHALLENGE, "::ffff:127.0.0.1", 4242)).not.toBe(expected);
    expect(proofFor(FAKE_TOKEN, Buffer.alloc(32, 8), "127.0.0.1", 4242)).not.toBe(expected);
  });
});

describe("a code is asked for", () => {
  it("proves first, then asks on the SAME connection; the proof request has no token", async () => {
    const { daemon, deps } = await setup();
    const got = await fetchOtp(APP, deps);
    expect(got).toMatchObject({ ok: true, code: FAKE_CODE, source: "com.apple.MobileSMS" });
    expect(daemon.connections).toBe(1);
    expect(daemon.requests.map((r) => `${r.method} ${r.url}`)).toEqual(["POST /api/prove", "POST /otp"]);
    expect(daemon.requests.every((r) => r.socket === 0)).toBe(true);
    const [prove, otp] = daemon.requests;
    expect(prove?.authorization).toBeUndefined();
    expect(prove?.body).not.toContain(FAKE_TOKEN);
    expect(JSON.parse(prove?.body ?? "{}")).toEqual({ challenge: CHALLENGE.toString("hex") });
    expect(prove?.host).toBe(`127.0.0.1:${daemon.port}`);
    expect(otp?.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(JSON.parse(otp?.body ?? "{}")).toEqual({ app: APP });
  });

  it("sends 32 random bytes as 64 hex characters when it makes the challenge itself", async () => {
    const { daemon, deps } = await setup();
    const { random: _random, ...real } = deps;
    await fetchOtp(APP, real);
    const challenge = (JSON.parse(daemon.requests[0]?.body ?? "{}") as { challenge: string }).challenge;
    expect(challenge).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reads a chunked answer", async () => {
    const { deps } = await setup({ otp: { status: 200, body: { code: "135790", expires: Date.now() + 60_000 }, chunked: true } });
    const got = await fetchOtp(APP, deps);
    expect(got).toMatchObject({ ok: true, code: "135790", source: undefined });
  });

  it("a code that has already expired is not typed", async () => {
    const { deps } = await setup({ otp: { status: 200, body: { code: FAKE_CODE, expires: 1000 } } });
    const got = await fetchOtp(APP, { ...deps, now: () => 5000 });
    expect(got).toMatchObject({ ok: false, reason: "expired" });
    expect(JSON.stringify(got)).not.toContain(FAKE_CODE);
  });

  it("an odd code or a source that is not a name is not trusted", async () => {
    const odd = await setup({ otp: { status: 200, body: { code: "12ab", expires: Date.now() + 60_000 } } });
    expect(await fetchOtp(APP, odd.deps)).toMatchObject({ ok: false, reason: "bad_reply" });
    const loud = await setup({ otp: { status: 200, body: { code: FAKE_CODE, expires: Date.now() + 60_000, source: `from ${FAKE_CODE}!` } } });
    expect(await fetchOtp(APP, loud.deps)).toMatchObject({ ok: true, source: undefined });
  });
});

describe("a daemon that doesn't prove itself", () => {
  it("a wrong proof: nothing more is sent, so the server never sees the token", async () => {
    const { daemon, deps } = await setup({ proofText: "0".repeat(64) });
    const got = await fetchOtp(APP, deps);
    expect(got).toMatchObject({ ok: false, reason: "no_proof" });
    expect(daemon.requests.map((r) => r.url)).toEqual(["/api/prove"]);
    expect(daemon.everything()).not.toContain(FAKE_TOKEN);
    expect(daemon.requests.some((r) => r.authorization !== undefined)).toBe(false);
  });

  it("a proof made with another token is wrong too", async () => {
    const { daemon, deps } = await setup({ token: "some-other-fake-token-fedcba9876543210" }, { token: FAKE_TOKEN });
    expect(await fetchOtp(APP, deps)).toMatchObject({ ok: false, reason: "no_proof" });
    expect(daemon.requests).toHaveLength(1);
  });

  it("a proof for a different port is rejected", async () => {
    const { daemon, deps } = await setup({ proofPort: (port) => port + 1 });
    expect(await fetchOtp(APP, deps)).toMatchObject({ ok: false, reason: "no_proof" });
    expect(daemon.requests).toHaveLength(1);
    expect(daemon.everything()).not.toContain(FAKE_TOKEN);
  });

  it("a proof for a different address is rejected, also for the ::ffff: spelling", async () => {
    for (const address of ["127.0.0.2", "::ffff:127.0.0.1", "localhost", "[::1]"]) {
      const { daemon, deps } = await setup({ proofAddress: address });
      expect(await fetchOtp(APP, deps)).toMatchObject({ ok: false, reason: "no_proof" });
      expect(daemon.requests).toHaveLength(1);
      expect(daemon.requests.some((r) => r.authorization !== undefined)).toBe(false);
    }
  });

  it("a connection the server closes after the proof gets nothing, and no new connection is opened", async () => {
    const { daemon, deps } = await setup({ afterProof: "close" });
    const got = await fetchOtp(APP, deps);
    expect(got).toMatchObject({ ok: false, reason: "closed" });
    expect(daemon.requests.map((r) => r.url)).toEqual(["/api/prove"]);
    expect(daemon.connections).toBe(1);
    expect(daemon.everything()).not.toContain(FAKE_TOKEN);
  });

  it("an answer that says Connection: close is treated the same way", async () => {
    const { daemon, deps } = await setup({ afterProof: "header" });
    expect(await fetchOtp(APP, deps)).toMatchObject({ ok: false, reason: "closed" });
    expect(daemon.requests.map((r) => r.url)).toEqual(["/api/prove"]);
    expect(daemon.connections).toBe(1);
  });

  it("a daemon that never answers the challenge ends in a timeout, with no token sent", async () => {
    const { daemon, deps } = await setup({ afterProof: "silent" });
    const got = await fetchOtp(APP, { ...deps, timeoutMs: 150 });
    expect(got).toMatchObject({ ok: false, reason: "timeout" });
    expect(daemon.everything()).not.toContain(FAKE_TOKEN);
  });

  it("something that isn't HTTP on the port gets no token", async () => {
    const received: Buffer[] = [];
    const junk = createServer((socket) => {
      socket.on("data", (chunk) => {
        received.push(chunk);
        socket.write("hello\r\n\r\n");
      });
    });
    await new Promise<void>((resolve) => junk.listen(0, "127.0.0.1", resolve));
    const address = junk.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const home = tapwrightHome({ port, token: FAKE_TOKEN });
    homes.push(home);
    const got = await fetchOtp(APP, { home: home.dir, settleMs: 0, timeoutMs: 1500 });
    junk.close();
    expect(got.ok).toBe(false);
    expect(Buffer.concat(received).toString("utf8")).not.toContain(FAKE_TOKEN);
  });
});

describe("a code that isn't there", () => {
  it("404 fails with the no-code words, and no code", async () => {
    const { deps } = await setup({ otp: { status: 404 } });
    const got = await fetchOtp(APP, deps);
    expect(got).toEqual({ ok: false, reason: "none", message: noCodeMessage(APP) });
    expect(noCodeMessage(APP)).toContain("Tapwright 1.7");
  });

  it("another status is a refusal", async () => {
    const { deps } = await setup({ otp: { status: 500 } });
    expect(await fetchOtp(APP, deps)).toMatchObject({ ok: false, reason: "refused" });
  });
});

describe("errors", () => {
  it("serve.json missing", async () => {
    const home = tapwrightHome(undefined);
    homes.push(home);
    const got = await fetchOtp(APP, { home: home.dir });
    expect(got).toMatchObject({ ok: false, reason: "no_file" });
  });

  it("serve.json malformed: the message quotes nothing from it", async () => {
    const home = tapwrightHome(`{"port": 1234, "token": "${FAKE_TOKEN}" `);
    homes.push(home);
    const got = await fetchOtp(APP, { home: home.dir });
    expect(got).toMatchObject({ ok: false, reason: "bad_file" });
    expect(JSON.stringify(got)).not.toContain(FAKE_TOKEN);
  });

  it("serve.json without a usable port or token", async () => {
    for (const serve of [{ token: FAKE_TOKEN }, { port: 8080 }, { port: "8080", token: FAKE_TOKEN }, { port: 0, token: FAKE_TOKEN }, { port: 70000, token: FAKE_TOKEN }, { port: 8080, token: "" }, [], null]) {
      const home = tapwrightHome(serve);
      homes.push(home);
      const got = await fetchOtp(APP, { home: home.dir });
      expect(got).toMatchObject({ ok: false, reason: "bad_file" });
      expect(JSON.stringify(got)).not.toContain(FAKE_TOKEN);
    }
  });

  it("the daemon is down", async () => {
    const daemon = await startFakeTapwright();
    const port = daemon.port;
    await daemon.close();
    const home = tapwrightHome({ port, token: FAKE_TOKEN });
    homes.push(home);
    const got = await fetchOtp(APP, { home: home.dir, timeoutMs: 2000 });
    expect(got).toMatchObject({ ok: false, reason: "unreachable" });
    expect(JSON.stringify(got)).not.toContain(FAKE_TOKEN);
  });

  it("TAPWRIGHT_HOME names the folder, and a home folder is used when it is not set", async () => {
    const { daemon, home } = await setup();
    expect(await fetchOtp(APP, { env: { TAPWRIGHT_HOME: home.dir }, random: () => CHALLENGE, settleMs: 5 })).toMatchObject({ ok: true });
    expect(daemon.requests.length).toBe(2);
    const empty = tapwrightHome(undefined);
    homes.push(empty);
    expect(await fetchOtp(APP, { env: {}, homeDir: () => empty.dir })).toMatchObject({ ok: false, reason: "no_file" });
  });
});

describe("the token is not cached", () => {
  it("serve.json is read at each request: a rotated token and a moved daemon are followed", async () => {
    const first = await startFakeTapwright({ token: "first-fake-token-aaaaaaaaaaaaaaaaaaaaa" });
    const second = await startFakeTapwright({ token: "second-fake-token-bbbbbbbbbbbbbbbbbbbb" });
    daemons.push(first, second);
    const home = tapwrightHome({ port: first.port, token: first.behavior.token });
    homes.push(home);
    const deps: OtpDeps = { home: home.dir, settleMs: 5 };
    expect(await fetchOtp(APP, deps)).toMatchObject({ ok: true });
    expect(first.requests[1]?.authorization).toBe(`Bearer ${first.behavior.token}`);
    home.write({ port: second.port, token: second.behavior.token });
    expect(await fetchOtp(APP, deps)).toMatchObject({ ok: true });
    expect(second.requests[1]?.authorization).toBe(`Bearer ${second.behavior.token}`);
    // The first daemon never saw the second token, nor the second the first.
    expect(first.everything()).not.toContain(second.behavior.token);
    expect(second.everything()).not.toContain(first.behavior.token);
    // And a file that has gone fails the next request: nothing was kept.
    home.write("not json");
    expect(await fetchOtp(APP, deps)).toMatchObject({ ok: false, reason: "bad_file" });
  });
});

describe("what is scrubbed", () => {
  it("a registered code reads <one-time code> in any text, in its other shapes too", () => {
    const codes = new OtpCodes();
    expect(codes.redact(`typed ${FAKE_CODE}`)).toBe(`typed ${FAKE_CODE}`);
    codes.register(FAKE_CODE);
    expect(codes.redact(`typed ${FAKE_CODE} here`)).toBe("typed <one-time code> here");
    expect(codes.redact(JSON.stringify({ value: FAKE_CODE }))).toBe('{"value":"<one-time code>"}');
    expect(codes.redact("nothing to hide")).toBe("nothing to hide");
    codes.register("905511");
    expect(codes.redact(`${FAKE_CODE} and 905511`)).toBe("<one-time code> and <one-time code>");
  });

  it("the service registers a code before it hands it on", async () => {
    const { deps } = await setup();
    const service = createOtpService(deps);
    expect(service.codes.redact(FAKE_CODE)).toBe(FAKE_CODE);
    const got = await service.fetch(APP);
    expect(got.ok).toBe(true);
    expect(service.codes.redact(`x${FAKE_CODE}y`)).toBe("x<one-time code>y");
  });
});
