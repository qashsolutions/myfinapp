import { readableIn } from "../leaks.ts";

describe("readableIn", () => {
  it("finds a word as readable JSON, a URL or plain text sets it", () => {
    expect(readableIn('{"name":"Apartment 4B"}', "4B")).toBe(true);
    expect(readableIn('{"amount_cents":1250}', "1250")).toBe(true);
    expect(readableIn("/api/splits?name=Trip", "Trip")).toBe(true);
    expect(readableIn("Trip", "Trip")).toBe(true);
  });

  it("ignores the same letters inside base64url ciphertext", () => {
    expect(readableIn('{"ciphertext":"xQ4Bk_9-Tripz12500"}', "4B")).toBe(false);
    expect(readableIn('{"ciphertext":"xQ4Bk_9-Tripz12500"}', "Trip")).toBe(false);
    expect(readableIn('{"ciphertext":"xQ4Bk_9-Tripz12500"}', "1250")).toBe(false);
  });
});
