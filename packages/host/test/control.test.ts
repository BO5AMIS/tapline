import { describe, expect, it } from "vitest";
import { ControlQueue } from "../src/control.js";
import { TaplineError } from "../src/server.js";

/** A clock the test moves by hand; `sleep` advances it. */
function fakeTime() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("ControlQueue", () => {
  it("runs one action at a time, in order", async () => {
    const queue = new ControlQueue();
    const order: string[] = [];
    let release: () => void = () => undefined;
    const first = queue.runAgent(async () => {
      order.push("first start");
      await new Promise<void>((resolve) => (release = resolve));
      order.push("first end");
    });
    const second = queue.runAgent(async () => {
      order.push("second");
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["first start"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first start", "first end", "second"]);
  });

  it("makes the agent wait until the person has been idle for 3 s", async () => {
    const time = fakeTime();
    const queue = new ControlQueue({ now: time.now, sleep: time.sleep });
    await queue.runPerson(async () => undefined);
    expect(queue.driver()).toBe("person");
    const started = time.now();
    let during: string | null = null;
    await queue.runAgent(async () => {
      during = queue.driver();
    });
    expect(time.now() - started).toBeGreaterThanOrEqual(3000);
    expect(during).toBe("agent");
  });

  it("names the driver only while they drive: the agent during its action, a person until they've been idle", async () => {
    const queue = new ControlQueue({ idleMs: 40 });
    expect(queue.driver()).toBeNull();
    await queue.runAgent(async () => expect(queue.driver()).toBe("agent"));
    expect(queue.driver()).toBeNull();
    const seen: Array<string | null> = [];
    queue.onChange(() => seen.push(queue.driver()));
    await queue.runPerson(async () => undefined);
    expect(queue.driver()).toBe("person");
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(queue.driver()).toBeNull();
    expect(seen).toEqual(["person", null]); // listeners hear when the person goes idle
  });

  it("gives up with busy after 30 s of a person driving", async () => {
    const time = fakeTime();
    const queue = new ControlQueue({ now: time.now, sleep: async (ms) => {
      time.advance(ms);
      await queue.runPerson(async () => undefined); // the person keeps going
    } });
    await queue.runPerson(async () => undefined);
    const error = await queue.runAgent(async () => "never").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TaplineError);
    expect((error as TaplineError).code).toBe("busy");
  });

  it("refuses agent actions while paused, but not a person's", async () => {
    const queue = new ControlQueue();
    queue.setPaused(true);
    const error = await queue.runAgent(async () => "x").catch((e: unknown) => e);
    expect((error as TaplineError).code).toBe("paused");
    await expect(queue.runPerson(async () => "ok")).resolves.toBe("ok");
    queue.setPaused(false);
    await expect(queue.runAgent(async () => "go")).resolves.toBe("go");
  });

  it("keeps going after an action throws", async () => {
    const queue = new ControlQueue();
    await expect(queue.runAgent(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(queue.runAgent(async () => "next")).resolves.toBe("next");
  });

  it("tells listeners when the driver or the pause changes", async () => {
    const queue = new ControlQueue();
    const seen: string[] = [];
    queue.onChange(() => seen.push(`${queue.driver() ?? "none"}/${String(queue.paused())}`));
    await queue.runAgent(async () => undefined);
    queue.setPaused(true);
    expect(seen).toEqual(["agent/false", "none/false", "none/true"]);
  });
});
