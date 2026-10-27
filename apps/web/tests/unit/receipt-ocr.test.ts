// @vitest-environment node
/**
 * The receipt text parser (fast-follow 6): pure, so the same OCR text always gives the same
 * merchant, date and total; amounts stay text for the engine to parse on save.
 */
import { amountsIn, parseReceiptText } from "../../src/features/receipts/ocr/parse.ts";

const AS_OF = "2026-10-10";
const RECEIPT = `CORNER MARKET
123 Main St, Dallas TX
10/09/2026  14:32

Milk 2%            3.49
Bread              2.99
Apples 2 lb        4.52

SUBTOTAL          11.00
TAX                0.91
TOTAL             11.91

VISA  ************1234
THANK YOU`;

describe("parseReceiptText", () => {
  it("reads the merchant, the date and the total line", () => {
    expect(parseReceiptText(RECEIPT, AS_OF)).toEqual({
      merchant: "Corner Market",
      date: "2026-10-09",
      total: "11.91",
      total_from: "total_line",
    });
  });

  it("prefers the last total over subtotal and tax, and takes an amount from the next line", () => {
    const text = "Joe's Diner\nSub total 20.00\nTax 1.60\nTOTAL DUE\n21.60\nChange 8.40";
    expect(parseReceiptText(text, AS_OF)).toMatchObject({
      merchant: "Joe's Diner",
      total: "21.60",
      total_from: "total_line",
    });
    const grand = "Shop\nTotal items 3\nGrand total $1,234.56\nTotal savings 12.00";
    expect(parseReceiptText(grand, AS_OF)).toMatchObject({
      total: "1234.56",
      total_from: "total_line",
    });
  });

  it("falls back to the largest amount, ignoring cash and change lines", () => {
    const text = "Bodega\nEggs 4.19\nCoffee 12.50\nCash 20.00\nChange 3.31";
    expect(parseReceiptText(text, AS_OF)).toMatchObject({
      merchant: "Bodega",
      total: "12.50",
      total_from: "largest",
    });
    expect(amountsIn("2 @ 1.25  2.50 $1,000.00")).toEqual(["1.25", "2.50", "1000.00"]);
  });

  it("understands the common date formats and never suggests a future date", () => {
    const at = (line: string) => parseReceiptText(`Shop\n${line}`, AS_OF).date;
    expect(at("2026-10-09")).toBe("2026-10-09");
    expect(at("10/09/26 09:12")).toBe("2026-10-09");
    expect(at("9-10-2026")).toBe("2026-09-10");
    expect(at("25/12/2025")).toBe("2025-12-25");
    expect(at("Oct 9, 2026")).toBe("2026-10-09");
    expect(at("September 30th, 2026")).toBe("2026-09-30");
    expect(at("9 Oct 2026")).toBe("2026-10-09");
    expect(at("12/25/2026")).toBeNull();
    expect(at("02/30/2026")).toBeNull();
    expect(at("13/13/2026")).toBeNull();
    expect(at("Order 4821")).toBeNull();
  });

  it("skips headers, addresses and card lines when naming the merchant", () => {
    expect(
      parseReceiptText("RECEIPT\nWelcome to\nTel 555-0100\nBlue Bakery\n4.00", AS_OF),
    ).toMatchObject({
      merchant: "Blue Bakery",
      total: "4.00",
    });
    expect(parseReceiptText("", AS_OF)).toEqual({
      merchant: null,
      date: null,
      total: null,
      total_from: null,
    });
    expect(
      parseReceiptText("A LONG STORE NAME THAT GOES ON AND ON FOR EVER AND EVER", AS_OF).merchant,
    ).toBe("A Long Store Name That Goes On And On");
  });
});
