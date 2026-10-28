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
});
