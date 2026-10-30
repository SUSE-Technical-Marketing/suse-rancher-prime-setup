import { ref, watch } from "vue";

// Light or dark: as the system says, or chosen in the header and kept in this browser. The choice
// lands on <html data-theme> (index.html sets it before the first paint, so there's no flash).

export type ThemeChoice = "system" | "light" | "dark";
const KEY = "lab-theme";
const dark = window.matchMedia("(prefers-color-scheme: dark)");

function saved(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export const theme = ref<ThemeChoice>(saved());

function apply() {
  document.documentElement.dataset.theme = theme.value === "system" ? (dark.matches ? "dark" : "light") : theme.value;
}

watch(theme, t => {
  try {
    if (t === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch { /* the choice is a convenience */ }
  apply();
}, { immediate: true });
dark.addEventListener("change", apply);

/** System, then light, then dark. */
export const nextTheme = (t: ThemeChoice): ThemeChoice => (t === "system" ? "light" : t === "light" ? "dark" : "system");
