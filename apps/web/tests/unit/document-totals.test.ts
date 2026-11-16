/**
 * Documents with a total, not transactions (November 16, 2026): investment positions and
 * statements, loans and mortgages, a positions CSV. Made-up documents only; the reader keeps a
 * name from the kind of account, the total, the date and the Net worth kind, never a number of
 * the account.
 */

import { parseAmount } from "../../src/engine/bridge.ts";
import { readCsvTotal, readDate, readDocumentTotal } from "../../src/importers/totals.ts";

describe("reading a document's total", () => {
  it("a brokerage positions page: Rollover IRA, its account total and the as-of date", async () => {
    const lines = [
      "9/3/26, 11:22 AM Portfolio Positions",
      "Positions",
      "Rollover IRA",
      "Brokerage: 123456789 · Routing number",
      "Overview As of Sep-03-2026 12:22 p.m. ET",
      "Symbol Last price Quantity Cost basis",
      "gain/loss gain/loss value account ran",
      "ABCD $10.00 5 $40.00",
      "Account total $1,250.40",
    ];
    expect(await readDocumentTotal(lines, parseAmount)).toEqual({
      kind: "asset",
      group: "retirement",
      label: "Rollover IRA",
      cents: 125040,
      as_of: "2026-09-03",
      doc: "investments",
      last4: "6789",
      kind_from: "Rollover IRA",
    });
  });

  it("an account number masked or whole gives its last four only; a date never does", async () => {
    const masked = await readDocumentTotal(
      ["Roth IRA", "Account ending in 4321", "Account value as of 06/30/2026 $9,000.00"],
      parseAmount,
    );
    expect(masked).toMatchObject({ last4: "4321", kind_from: "Roth IRA" });
    const loan = await readDocumentTotal(
      ["Mortgage Statement", "Loan number: 0012-345678", "Principal balance $200,000.00"],
      parseAmount,
    );
    expect(loan).toMatchObject({ last4: "5678" });
    const none = await readDocumentTotal(
      [
        "Example Brokerage",
        "Statement date 10/31/2026",
        "Total account value $1,000.00",
        "Brokerage",
      ],
      parseAmount,
    );
    expect(none).toMatchObject({ last4: null, kind_from: "Brokerage" });
    const guessed = await readDocumentTotal(
      ["Positions", "Symbol Quantity Market value", "Account total $500.00"],
      parseAmount,
    );
    expect(guessed).toMatchObject({ group: "investments", kind_from: null });
  });

  it("a monthly brokerage statement with its value on the next line", async () => {
    const lines = [
      "Example Brokerage",
      "Individual Brokerage Account",
      "Statement period 10/01/2026 - 10/31/2026",
      "Total account value",
      "$52,310.18",
    ];
    expect(await readDocumentTotal(lines, parseAmount)).toMatchObject({
      group: "investments",
      label: "Brokerage",
      cents: 5231018,
      as_of: "2026-10-31",
    });
  });

  it("a 401(k) and an HSA count as retirement", async () => {
    const k = await readDocumentTotal(
      ["Your 401(k) Plan", "Account value as of 06/30/2026 $88,000.00"],
      parseAmount,
    );
    expect(k).toMatchObject({ label: "401(k)", group: "retirement", cents: 8800000 });
    const hsa = await readDocumentTotal(
      ["Health Savings Account", "Account total $4,120.00", "As of July 1, 2026"],
      parseAmount,
    );
    expect(hsa).toMatchObject({ label: "HSA", group: "retirement", as_of: "2026-07-01" });
  });

  it("a mortgage and a car loan: the principal owed, as debts", async () => {
    const mortgage = await readDocumentTotal(
      [
        "Example Home Lending",
        "Mortgage Statement",
        "Statement date 10/15/2026",
        "Unpaid principal balance $312,450.77",
        "Amount due $2,104.10",
      ],
      parseAmount,
    );
    expect(mortgage).toEqual({
      kind: "debt",
      group: "mortgage",
      label: "Mortgage",
      cents: 31245077,
      as_of: "2026-10-15",
      doc: "loan",
      last4: null,
      kind_from: "Mortgage",
    });
    const car = await readDocumentTotal(
      ["Auto loan statement", "Principal balance", "$14,980.00"],
      parseAmount,
    );
    expect(car).toMatchObject({
      kind: "debt",
      group: "auto_loan",
      label: "Car loan",
      cents: 1498000,
    });
  });

  it("a bank or card statement has no total of this kind", async () => {
    expect(
      await readDocumentTotal(
        [
          "First Example Bank",
          "Everyday Checking",
          "Statement period 09/10/2026 - 10/09/2026",
          "09/12 DIRECT DEPOSIT 2,600.00 3,814.22",
          "Ending balance 3,460.12",
        ],
        parseAmount,
      ),
    ).toBeNull();
    expect(
      await readDocumentTotal(
        ["Rewards Card", "New balance $505.50", "Minimum payment due $35.00"],
        parseAmount,
      ),
    ).toBeNull();
  });

  it("a positions CSV: the holdings summed, the account named, pending and totals left out", async () => {
    const headers = ["Account Number", "Account Name", "Symbol", "Description", "Current Value"];
    const rows = [
      ["X1", "ROTH IRA", "SPAXX**", "MONEY MARKET", "$1,000.00"],
      ["X1", "ROTH IRA", "ABCD", "EXAMPLE CORP", "$2,500.50"],
      ["X1", "ROTH IRA", "Pending Activity", "", "$12.00"],
      ["Date downloaded 09/03/2026 11:22 AM"],
    ];
    expect(await readCsvTotal(headers, rows, parseAmount)).toEqual({
      kind: "asset",
      group: "retirement",
      label: "Roth IRA",
      cents: 350050,
      as_of: "2026-09-03",
      doc: "investments",
      last4: null,
      kind_from: "Roth IRA",
    });
    expect(
      await readCsvTotal(
        ["Account Number", "Symbol", "Current Value"],
        [["Z98765432", "ABCD", "$10.00"]],
        parseAmount,
      ),
    ).toMatchObject({ last4: "5432" });
    expect(await readCsvTotal(["Date", "Description", "Amount"], [["x"]], parseAmount)).toBeNull();
  });

  it("reads the dates statements print, and refuses impossible ones", () => {
    expect(readDate("Sep-03-2026 12:22")).toBe("2026-09-03");
    expect(readDate("September 3, 2026")).toBe("2026-09-03");
    expect(readDate("on 09/03/2026")).toBe("2026-09-03");
    expect(readDate("13/40/2026")).toBeNull();
    expect(readDate("no date")).toBeNull();
  });
});
