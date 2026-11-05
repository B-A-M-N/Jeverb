import { describe, expect, it } from "vitest";
import { daemonStartupBanner } from "../../src/hooks/daemon/banner.js";

describe("daemon startup banner", () => {
  const base = {
    version: "0.6.0",
    protocol: 1,
    port: 39271,
    dataDir: "/tmp/jev-test",
    restarts: 0,
  };

  it("reports the key count and stays quiet when keys are held", () => {
    expect(daemonStartupBanner({ ...base, keyCount: 2 }).line).toContain("auth 2 keys");
    expect(daemonStartupBanner({ ...base, keyCount: 2 }).warning).toBeUndefined();
    expect(daemonStartupBanner({ ...base, keyCount: 1 }).line).toContain("auth 1 key");
  });

  it("warns that the loopback API is unauthenticated when no keys are held", () => {
    const banner = daemonStartupBanner({ ...base, keyCount: 0 });
    expect(banner.line).toContain("auth none");
    expect(banner.warning).toContain("WARNING");
    expect(banner.warning).toContain("unauthenticated");
  });
});
