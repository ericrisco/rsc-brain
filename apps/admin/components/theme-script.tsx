const themeBootstrap = `
(function () {
  var key = "rsc-brain.theme";
  var allowed = ["system", "light", "dark"];
  var stored = null;
  try { stored = window.localStorage.getItem(key); } catch (_) {}
  var theme = allowed.indexOf(stored) >= 0 ? stored : "system";
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme === "system"
    ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : theme;
})();`;

/** Runs before hydration so System/Light/Dark never flashes the wrong canvas. */
export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />;
}
