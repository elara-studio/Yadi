import { describe, expect, it } from "vitest";
import { SpeedMeter, formatBytes, formatSpeed, percent, redactPersonalPaths } from "./format";

describe("formatBytes / formatSpeed / percent", () => {
  it("formats sizes", () => {
    expect(formatBytes(2_099_520_968)).toBe("2.1 GB");
    expect(formatBytes(208_576_005)).toBe("209 MB");
    expect(formatBytes(4_096)).toBe("4 KB");
    expect(formatBytes(-5)).toBe("0 KB");
  });
  it("formats speed", () => {
    expect(formatSpeed(12_500_000)).toBe("12.5 MB/s");
  });
  it("percent clamps and handles unknown totals", () => {
    expect(percent(50, 200)).toBe(25);
    expect(percent(300, 200)).toBe(100);
    expect(percent(-1, 200)).toBe(0);
    expect(percent(5, null)).toBeNull();
    expect(percent(5, 0)).toBeNull();
  });
});

describe("SpeedMeter", () => {
  it("needs two samples far enough apart", () => {
    const m = new SpeedMeter();
    expect(m.add(0, 0)).toBeNull();
    expect(m.add(100, 1000)).toBeNull(); // under 250 ms apart
    expect(m.add(1000, 10_000_000)).toBe(10_000_000);
  });
  it("only looks at the recent window", () => {
    const m = new SpeedMeter(2000);
    m.add(0, 0);
    m.add(1000, 1_000_000);
    // a long stall, then fast progress: the old samples have dropped out of the window
    m.add(10_000, 1_000_000);
    expect(m.add(11_000, 21_000_000)).toBe(20_000_000);
  });
  it("never reports a negative speed (e.g. after a restart of the download)", () => {
    const m = new SpeedMeter();
    m.add(0, 5000);
    expect(m.add(1000, 100)).toBeNull();
  });
  it("reset forgets everything", () => {
    const m = new SpeedMeter();
    m.add(0, 0);
    m.reset();
    expect(m.add(1000, 1000)).toBeNull();
  });
});

describe("redactPersonalPaths", () => {
  it("replaces home folders on every platform", () => {
    expect(redactPersonalPaths("cannot write /Users/jane/Library/x")).toBe(
      "cannot write ~/Library/x",
    );
    expect(redactPersonalPaths("open /home/bob/.cache failed")).toBe("open ~/.cache failed");
    expect(redactPersonalPaths(String.raw`C:\Users\Alex Smith\AppData`)).toBe(
      String.raw`~\AppData`,
    );
    expect(redactPersonalPaths(String.raw`D:\Users\alex\x`)).toBe(String.raw`~\x`);
  });
  it("leaves other text alone", () => {
    expect(redactPersonalPaths("Download failed: timeout")).toBe("Download failed: timeout");
  });
});
