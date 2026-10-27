import { describe, expect, it } from "vitest";

import { AA_BODY, contrastPairs, contrastRatio, luminance } from "./contrast";

describe("contrast math", () => {
  it("matches the WCAG reference points", () => {
    expect(luminance("#FFFFFF")).toBeCloseTo(1, 6);
    expect(luminance("#000000")).toBeCloseTo(0, 6);
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 6);
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 6);
    expect(contrastRatio("#777777", "#FFFFFF")).toBeCloseTo(4.48, 2);
    expect(contrastRatio("#3D5AFE", "#FFFFFF")).toBeGreaterThan(AA_BODY);
  });

  it("rejects anything that is not #RRGGBB", () => {
    expect(() => luminance("#FFF")).toThrow();
    expect(() => luminance("white")).toThrow();
  });

  it("lists the same pairs for every look and mode", () => {
    const pairs = contrastPairs();
    const perCombo = new Map<string, number>();
    for (const p of pairs)
      perCombo.set(`${p.look}/${p.mode}`, (perCombo.get(`${p.look}/${p.mode}`) ?? 0) + 1);
    expect(perCombo.size).toBe(12);
    expect(new Set(perCombo.values()).size).toBe(1);
  });
});
