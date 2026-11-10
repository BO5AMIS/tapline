import { describe, expect, it } from "vitest";
import { viaOf } from "../src/server.js";

describe("viaOf", () => {
  it("names Tailscale for its address ranges", () => {
    expect(viaOf("100.64.0.7")).toBe("tailscale");
    expect(viaOf("::ffff:100.101.102.103")).toBe("tailscale");
    expect(viaOf("fd7a:115c:a1e0::1")).toBe("tailscale");
  });

  it("names the local network for anything else", () => {
    expect(viaOf("192.168.1.20")).toBe("wifi");
    expect(viaOf("::ffff:10.0.0.4")).toBe("wifi");
    expect(viaOf("100.128.0.1")).toBe("wifi");
    expect(viaOf("127.0.0.1")).toBe("wifi");
  });

  it("says nothing without an address", () => {
    expect(viaOf(undefined)).toBeUndefined();
    expect(viaOf("")).toBeUndefined();
  });
});
