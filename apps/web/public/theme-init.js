/* Before first paint: apply the saved mode and layout so there is no flash. Mirrors
 * ThemeProvider. A file, not an inline script, so the app's Content-Security-Policy can stay
 * script-src 'self' (docs/ops/aws-hosting.md, step C). */
(() => {
  try {
    const h = document.documentElement;
    const mode = localStorage.getItem("stackd.mode");
    if (mode === "light" || mode === "dark") h.setAttribute("data-mode", mode);
    h.setAttribute("data-simple", localStorage.getItem("stackd.simple") === "1" ? "1" : "0");
  } catch {}
})();
