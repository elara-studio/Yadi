import { describe, expect, it } from "vitest";
import { coreVersion } from "./index";

describe("core", () => {
  it("exposes a version", () => {
    expect(coreVersion()).toBe("0.1.0");
  });
});
