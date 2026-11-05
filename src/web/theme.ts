// Light, dark, or Auto, which follows the system. The choice is per browser. index.html applies it
// before the first paint, with the same key and rule as here, so a reload never flashes the wrong one.

export type Theme = "auto" | "light" | "dark";

const KEY = "stand.theme";
const system = window.matchMedia("(prefers-color-scheme: dark)");

export function savedTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : "auto";
  } catch {
    return "auto";
  }
}

/** Switches all at once: without the pause, anything with a color fade lags behind the rest. */
const apply = (theme: Theme) => {
  const root = document.documentElement;
  root.classList.add("theme-switching");
  root.dataset.theme = theme === "auto" ? (system.matches ? "dark" : "light") : theme;
  void getComputedStyle(document.body).color;
  root.classList.remove("theme-switching");
};

export function setTheme(theme: Theme) {
  try {
    if (theme === "auto") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {}
  apply(theme);
}

// Auto keeps following the system while the page is open.
system.addEventListener("change", () => apply(savedTheme()));
