import { wordTone } from "../../src/app/layout/Word.tsx";

describe("wordTone (spec: One word first)", () => {
  it("colours Done and Clear green (owner decision, October 28, 2026)", () => {
    expect(wordTone("Done")).toBe("good");
    expect(wordTone("Clear")).toBe("good");
  });

  it("keeps Growing plain and Over red", () => {
    expect(wordTone("Growing")).toBe("plain");
    expect(wordTone("Over")).toBe("bad");
  });

  it("makes Reported red and keeps Double-check plain (owner, November 18, 2026)", () => {
    expect(wordTone("Reported")).toBe("bad");
    expect(wordTone("Double-check")).toBe("plain");
  });
});
