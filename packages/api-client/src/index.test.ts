import { readFileSync } from "node:fs";
import { authSignalOf, createApiClient } from "./index.ts";

const document = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8"));

describe("openapi snapshot", () => {
  it("has the auth and security routes the app depends on", () => {
    const paths = Object.keys(document.paths);
    for (const p of [
      "/api/auth/otp/send",
      "/api/auth/otp/verify",
      "/api/auth/session",
      "/api/auth/signout",
      "/api/security/passkeys/register/options",
      "/api/security/passkeys/register/verify",
      "/api/security/passkeys/assert/options",
      "/api/security/passkeys/assert/verify",
      "/api/security/passkeys",
      "/api/security/passkeys/{passkey_id}",
      "/api/security/devices",
      "/api/security/devices/{session_id}",
    ]) {
      expect(paths).toContain(p);
    }
  });
});

describe("createApiClient", () => {
  it("calls same-origin with cookies and reports auth signals", async () => {
    const seen: string[] = [];
    const calls: Array<{ url: string; credentials: RequestCredentials | undefined }> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      calls.push({ url: request.url, credentials: request.credentials });
      return new Response(JSON.stringify({ detail: "locked" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    };
    // Node needs an absolute URL for Request(); in the browser baseUrl "" resolves against the page.
    const api = createApiClient({
      baseUrl: "http://app.test",
      fetch: fetchMock,
      onAuthSignal: (s) => seen.push(s),
    });
    const { error, response } = await api.GET("/api/security/devices");
    expect(calls[0]?.url).toBe("http://app.test/api/security/devices");
    expect(calls[0]?.credentials).toBe("include");
    expect(response.status).toBe(403);
    expect(error).toEqual({ detail: "locked" });
    expect(seen).toEqual(["locked"]);
  });

  it("authSignalOf ignores other errors", async () => {
    const r = new Response(JSON.stringify({ detail: "not_found" }), { status: 404 });
    expect(await authSignalOf(r)).toBeNull();
    const r2 = new Response("nope", { status: 403 });
    expect(await authSignalOf(r2)).toBeNull();
  });
});
