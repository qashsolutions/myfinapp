// @vitest-environment node
/**
 * PDF statements on the device (fast-follow 2): a real PDF (built in the test) goes through
 * pdf.js to lines, and the generic template reads dates, descriptions, amounts (signed from
 * the running balance), the account's last four, the period and the ending balance.
 */

import { parseAmount } from "../../src/engine/bridge.ts";
import { extractLines, joinRuns } from "../../src/importers/pdf/extract.ts";
import { PdfError, parsePdfLines } from "../../src/importers/pdf/templates.ts";
import { buildPdf, sampleStatementPdf } from "../fixtures/pdf.ts";

describe("PDF statement import", () => {
  it("rebuilds lines from positioned runs, top to bottom and left to right", () => {
    expect(
      joinRuns([
        { x: 110, y: 700, text: "CORNER", width: 30 },
        { x: 50, y: 700, text: "09/14", width: 20 },
        { x: 50, y: 720, text: "Header", width: 30 },
        { x: 400, y: 699, text: "-54.10", width: 20 },
      ]),
    ).toEqual(["Header", "09/14 CORNER -54.10"]);
  });

  it("extracts the text layer of a generated statement", async () => {
    const lines = await extractLines(sampleStatementPdf());
    expect(lines[0]).toBe("First Example Bank");
    expect(lines).toContain("Statement period 09/10/2026 - 10/09/2026");
    expect(lines).toContain("09/14 CORNER MKT #214 1234567890124821 -54.10 3,760.12");
    expect(lines.at(-1)).toBe("Ending balance 2,260.12");
  });

  it("the generic template reads the rows, signs them from the balance, masks account numbers", async () => {
    const statement = await parsePdfLines(await extractLines(sampleStatementPdf()), parseAmount);
    expect(statement.template_key).toBe("generic_lines");
    expect(statement.institution).toBe("First Example Bank");
    expect(statement.account.last4).toBe("4821");
    expect(statement.period).toEqual({ start: "2026-09-10", end: "2026-10-09" });
    expect(statement.ledger).toEqual({ cents: 226012, as_of: "2026-10-09" });
    expect(statement.skipped).toBe(0);
    expect(statement.reconciles).toBe(true); // the last running balance is the ending balance
    expect(
      statement.rows.map((r) => [r.date, r.description, r.amount_cents, r.balance_cents]),
    ).toEqual([
      ["2026-09-12", "DIRECT DEPOSIT ACME PAYROLL", 260000, 381422],
      ["2026-09-14", "CORNER MKT #••4821", -5410, 376012],
      ["2026-09-20", "ONLINE PAYMENT TO CARD ••1173", -120000, 256012],
      ["2026-10-02", "CHECK 1041", -30000, 226012],
    ]);
    expect(JSON.stringify(statement)).not.toContain("1234567890124821");
  });

  it("an unsigned withdrawal column still gets its sign from the running balance; a December line on a January statement keeps last year", async () => {
    const statement = await parsePdfLines(
      [
        "Some Bank",
        "Statement period 12/15/2026 - 01/14/2027",
        "12/20 GROCERY 40.00 960.00",
        "01/03 PAYROLL 1,000.00 1,960.00",
        "01/05 RENT 900.00 1,060.00",
      ],
      parseAmount,
    );
    expect(statement.rows.map((r) => [r.date, r.amount_cents])).toEqual([
      ["2026-12-20", 4000], // the first row has no earlier balance to compare with
      ["2027-01-03", 100000],
      ["2027-01-05", -90000],
    ]);
  });

  it("a printed opening balance settles the first row's sign; the rows are checked against the ending balance (October 22, 2026)", async () => {
    const lines = (ending: string) => [
      "Some Bank",
      "Statement period 12/15/2026 - 01/14/2027",
      "Beginning balance 1,000.00",
      "12/20 GROCERY 40.00 960.00",
      "01/03 PAYROLL 1,000.00 1,960.00",
      "01/05 RENT 900.00 1,060.00",
      `Ending balance ${ending}`,
    ];
    const good = await parsePdfLines(lines("1,060.00"), parseAmount);
    expect(good.rows.map((r) => r.amount_cents)).toEqual([-4000, 100000, -90000]);
    expect(good.reconciles).toBe(true);
    // A statement whose rows don't reach its ending balance says so instead of importing quietly.
    expect((await parsePdfLines(lines("1,160.00"), parseAmount)).reconciles).toBe(false);
    // No running balance: the opening balance plus every row must reach the ending balance.
    const plain = await parsePdfLines(
      [
        "Some Bank",
        "Statement period 10/01/2026 - 10/31/2026",
        "Previous balance 500.00",
        "10/02 COFFEE -4.50",
        "10/03 REFUND 10.00",
        "New balance 505.50",
      ],
      parseAmount,
    );
    expect(plain.reconciles).toBe(true);
    // Nothing to check against: unknown, not "fine".
    const bare = await parsePdfLines(
      ["Some Bank", "Statement period 10/01/2026 - 10/31/2026", "10/02 COFFEE -4.50"],
      parseAmount,
    );
    expect(bare.reconciles).toBeNull();
  });

  it("refuses an empty text layer and an unknown layout, and reads bracketed and trailing-minus amounts", async () => {
    await expect(parsePdfLines([], parseAmount)).rejects.toBeInstanceOf(PdfError);
    await expect(parsePdfLines(["Hello", "World"], parseAmount)).rejects.toMatchObject({
      code: "unsupported_layout",
    });
    const statement = await parsePdfLines(
      [
        "Card",
        "Statement 09/01/2026 to 09/30/2026",
        "09/02 COFFEE (4.50)",
        "09/03 REFUND 4.50-",
        "09/04 PAYMENT 20.00 CR",
      ],
      parseAmount,
    );
    expect(statement.rows.map((r) => r.amount_cents)).toEqual([-450, -450, 2000]);
    expect(await extractLines(buildPdf([]))).toEqual([]);
  });
});
