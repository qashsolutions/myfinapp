import { startAuthentication } from "@simplewebauthn/browser";
import { assertPasskeyWithPrf } from "../../src/features/security/webauthn.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";

/**
 * The backup's PRF salt reaches the browser as bytes (November 10, 2026). The server sends it as
 * base64url text inside the options, and a browser refuses text there ("not of type
 * ArrayBuffer"), so "Unlock with" could never open a backup and turning backup on fell back to
 * the recovery key alone. Found by the backup journey in e2e/backup.spec.ts.
 */
describe("assertPasskeyWithPrf", () => {
  it("hands the browser the salt as bytes, not the server's text", async () => {
    installFakeApi({ session: readySession() });
    vi.mocked(startAuthentication).mockClear();
    const salt = new Uint8Array(32).map((_, i) => i * 7);
    await assertPasskeyWithPrf("step_up", salt);
    const options = vi.mocked(startAuthentication).mock.calls[0]?.[0]?.optionsJSON as unknown as {
      extensions: { prf: { eval: { first: unknown } } };
    };
    const first = options.extensions.prf.eval.first;
    expect(first instanceof Uint8Array || first instanceof ArrayBuffer).toBe(true);
    expect([...new Uint8Array(first as ArrayBuffer)]).toEqual([...salt]);
  });

  it("asks for no PRF when no salt is given", async () => {
    installFakeApi({ session: readySession() });
    vi.mocked(startAuthentication).mockClear();
    await assertPasskeyWithPrf("step_up", null);
    const options = vi.mocked(startAuthentication).mock.calls[0]?.[0]?.optionsJSON as unknown as {
      extensions?: unknown;
    };
    expect(options.extensions).toBeUndefined();
  });
});
