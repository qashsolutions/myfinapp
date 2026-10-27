import { manifest } from "../../src/pwa/manifest.ts";

describe("web app manifest", () => {
  it("matches the spec: #3D5AFE theme and background, standalone, 512 any + maskable, 192", () => {
    expect(manifest.theme_color).toBe("#3D5AFE");
    expect(manifest.background_color).toBe("#3D5AFE");
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
    const icons = manifest.icons ?? [];
    const by = (sizes: string, purpose?: string) =>
      icons.find(
        (i) =>
          i.sizes === sizes &&
          (purpose ? i.purpose === purpose : !i.purpose || i.purpose === "any"),
      );
    expect(by("512x512", "any")).toBeDefined();
    expect(by("512x512", "maskable")).toBeDefined();
    expect(by("192x192")).toBeDefined();
  });
});
