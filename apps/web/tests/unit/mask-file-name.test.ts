/** File names never show an account number (owner decision, November 16, 2026). */
import { maskFileName } from "../../src/importers/masking.ts";

describe("maskFileName", () => {
  it.each([
    ["Positions_250044484.pdf", "Positions_••4484.pdf"],
    ["card 4111 1111 1111 1173.pdf", "card ••1173.pdf"],
    ["acct-1234-5678-9012.csv", "acct-••9012.csv"],
    ["Checking_48213.csv", "Checking_••8213.csv"],
    ["Statement_2026-10-31.pdf", "Statement_2026-10-31.pdf"],
    ["Statement_20261031.pdf", "Statement_20261031.pdf"],
    ["stmt 10-31-2026.pdf", "stmt 10-31-2026.pdf"],
    ["Chase_4821_Oct.pdf", "Chase_4821_Oct.pdf"],
    ["2026_10_31.pdf", "2026_10_31.pdf"],
    ["Portfolio_Positions_IRA.pdf", "Portfolio_Positions_IRA.pdf"],
  ])("%s → %s", (name, shown) => {
    expect(maskFileName(name)).toBe(shown);
  });
});
