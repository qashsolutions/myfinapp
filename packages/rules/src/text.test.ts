import { describe, expect, it } from "vitest";
import { collapseSpaces, compareText, trimSpaces } from "./text.ts";

// Python's answer for each pair: sorted() and < compare str by code point.
describe("compareText orders by code point, as Python does", () => {
  it.each([
    ["B", "a", -1], // upper case first; a locale would put a first
    ["Z", "_", -1], // 0x5A < 0x5F; a locale puts punctuation first
    ["_", "É", -1], // 0x5F < 0xC9; a locale reads É as E
    ["￮", "\u{1F600}", -1], // U+FFEE < U+1F600; UTF-16 units put the emoji first
    ["\ud800", "", -1], // a lone surrogate is its own code point, as in Python
    ["A", "AB", -1],
    ["same", "same", 0],
  ])("%j before %j", (a, b, sign) => {
    expect(Math.sign(compareText(a, b))).toBe(sign);
    expect(Math.sign(compareText(b, a))).toBe(sign === 0 ? 0 : -sign);
  });

  it("never depends on the device's language", () => {
    const words = ["b", "B", "a", "_", "-", "Z", "é", "\u{1F600}", "￮"];
    expect([...words].sort(compareText)).toEqual([
      "-",
      "B",
      "Z",
      "_",
      "a",
      "b",
      "é",
      "￮",
      "\u{1F600}",
    ]);
  });
});

describe("one whitespace list", () => {
  it("treats BOM, no-break and em spaces as spaces, never U+001C or U+0085", () => {
    expect(collapseSpaces("a﻿ b c\u001cd\u0085e")).toBe("a b c\u001cd\u0085e");
    expect(trimSpaces("﻿ x 　")).toBe("x");
    expect(trimSpaces("\u001cx\u0085")).toBe("\u001cx\u0085");
  });
});
