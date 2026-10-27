import { readFileSync } from "node:fs";
import { parseAmount } from "../../src/engine/bridge.ts";
import {
  applyMapping,
  guessDateFormat,
  guessMapping,
  parseCsv,
  parseDateCell,
} from "../../src/importers/csv.ts";
import { last4, maskNumbers } from "../../src/importers/masking.ts";
import { looksLikeOfx, parseOfx } from "../../src/importers/ofx.ts";

const fixture = (name: string) => readFileSync(`${process.cwd()}/tests/fixtures/${name}`, "utf8");

describe("masking", () => {
  it("keeps only the last four digits of long numbers", () => {
    expect(maskNumbers("PAYMENT TO CARD 4111111111111173")).toBe("PAYMENT TO CARD ••1173");
    expect(maskNumbers("ACCT 0001 2345 4821 TRANSFER")).toBe("ACCT ••4821 TRANSFER");
    expect(maskNumbers("CORNER MKT #214 10/08 $42.17")).toBe("CORNER MKT #214 10/08 $42.17");
    expect(last4("000123454821")).toBe("4821");
    expect(last4("12")).toBeNull();
  });
});

describe("csv", () => {
  it("parses quotes, commas inside quotes, CRLF and a BOM", () => {
    const t = parseCsv('﻿Date,Description,Amount\r\n10/08/2026,"Smith, John ""JJ""",-1.50\r\n\r\n');
    expect(t.headers).toEqual(["Date", "Description", "Amount"]);
    expect(t.rows).toEqual([["10/08/2026", 'Smith, John "JJ"', "-1.50"]]);
    expect(parseCsv("a;b\n1;2\n").delimiter).toBe(";");
  });

  it("guesses the mapping from headers and the date format from samples", () => {
    const t = parseCsv(fixture("statement_oct.csv"));
    const m = guessMapping(t);
    expect(m).toMatchObject({
      date: 0,
      description: 1,
      amount: 2,
      balance: 3,
      debit: null,
      credit: null,
      sign: "negative_out",
      date_format: "MDY",
    });
    const two = parseCsv(
      "Date,Details,Debit,Credit\n25/09/2026,RENT,1650.00,\n01/10/2026,SALARY,,2400.00\n",
    );
    expect(guessMapping(two)).toMatchObject({
      amount: null,
      debit: 2,
      credit: 3,
      date_format: "DMY",
    });
    expect(guessDateFormat(["2026-10-08"])).toBe("YMD");
  });

  it("reads dates in every supported layout and rejects the rest", () => {
    expect(parseDateCell("10/08/2026", "MDY")).toBe("2026-10-08");
    expect(parseDateCell("08/10/2026", "DMY")).toBe("2026-10-08");
    expect(parseDateCell("2026-10-08", "DMY")).toBe("2026-10-08");
    expect(parseDateCell("10/8/26", "MDY")).toBe("2026-10-08");
    expect(parseDateCell("13/08/2026", "MDY")).toBeNull();
    expect(parseDateCell("02/30/2026", "MDY")).toBeNull();
    expect(parseDateCell("Oct 8", "MDY")).toBeNull();
  });

  it("applies the mapping through the engine, honouring the sign convention and debit/credit", async () => {
    const t = parseCsv(fixture("statement_oct.csv"));
    const { rows, skipped } = await applyMapping(t, guessMapping(t), parseAmount);
    expect(skipped).toEqual([]);
    expect(rows.map((r) => [r.date, r.description, r.amount_cents, r.balance_cents])).toEqual([
      ["2026-10-08", "CORNER MKT #214", -4217, 210000],
      ["2026-10-07", "METRO TRANSIT", -275, 214217],
      ["2026-10-06", "PAYMENT TO CARD ••1173", -120000, 214492],
      ["2026-10-02", "ACME PAYROLL", 240000, 334492],
    ]);
    const flipped = await applyMapping(t, { ...guessMapping(t), sign: "negative_in" }, parseAmount);
    expect(flipped.rows[0]?.amount_cents).toBe(4217);
    const two = parseCsv(
      "Date,Details,Debit,Credit\n25/09/2026,RENT,1650.00,\n01/10/2026,SALARY,,2400.00\nbad,row,,\n",
    );
    const r2 = await applyMapping(two, guessMapping(two), parseAmount);
    expect(r2.rows.map((r) => r.amount_cents)).toEqual([-165000, 240000]);
    expect(r2.skipped).toEqual([{ row: 4, reason: "date" }]);
  });
});

describe("ofx", () => {
  it("reads an SGML credit-card statement: masked account, charges, ledger balance, period", async () => {
    const text = fixture("card_oct.ofx");
    expect(looksLikeOfx(text)).toBe(true);
    const s = await parseOfx(text, parseAmount);
    expect(s.account).toEqual({ last4: "1173", type: "credit_card", institution: "Rewards Bank" });
    expect(s.rows.map((r) => [r.date, r.description, r.amount_cents])).toEqual([
      ["2026-10-07", "NETFLIX.COM ••7172", -1499], // the phone number is masked like any long number
      ["2026-10-06", "PAYMENT - THANK YOU", 120000],
    ]);
    expect(s.ledger).toEqual({ cents: -31245, as_of: "2026-10-08" });
    expect(s.period).toEqual({ start: "2026-10-01", end: "2026-10-08" });
  });

  it("reads an XML (QFX 2.x) checking statement", async () => {
    const s = await parseOfx(fixture("checking.qfx"), parseAmount);
    expect(s.account).toEqual({ last4: "4821", type: "checking", institution: null });
    expect(s.rows).toHaveLength(2);
    expect(s.rows[1]).toMatchObject({
      date: "2026-10-02",
      description: "ACME PAYROLL DIRECT DEP",
      amount_cents: 240000,
    });
    expect(s.ledger).toEqual({ cents: 210000, as_of: "2026-10-08" });
    expect(looksLikeOfx("Date,Amount\n")).toBe(false);
  });
});
