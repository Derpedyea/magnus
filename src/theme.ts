import { createStore } from "@tanstack/react-store";

/** Each has a [data-theme] block in index.css. The first of each kind is its default. */
export const THEMES = [
	{ id: "light", name: "Magnus Light", dark: false },
	{ id: "one-light", name: "One Light", dark: false },
	{ id: "catppuccin-latte", name: "Catppuccin Latte", dark: false },
	{ id: "rose-pine-dawn", name: "Rosé Pine Dawn", dark: false },
	{ id: "solarized-light", name: "Solarized Light", dark: false },
	{ id: "gruvbox-light", name: "Gruvbox Light", dark: false },
	{ id: "dark", name: "Magnus Dark", dark: true },
	{ id: "one-dark", name: "One Dark", dark: true },
	{ id: "catppuccin-mocha", name: "Catppuccin Mocha", dark: true },
	{ id: "rose-pine", name: "Rosé Pine", dark: true },
	{ id: "solarized-dark", name: "Solarized Dark", dark: true },
	{ id: "gruvbox-dark", name: "Gruvbox Dark", dark: true },
	{ id: "nord", name: "Nord", dark: true },
	{ id: "dracula", name: "Dracula", dark: true },
] as const;
export type Theme = (typeof THEMES)[number];

/** Like Zed and VS Code: follow the OS between a light and a dark theme, or stick to one. */
export const MODES = ["system", "light", "dark"] as const;
export type Mode = (typeof MODES)[number];

// Per device, like the OS setting it defaults to. The inline script in index.html reads the same keys to
// apply the theme before first paint; this module keeps it applied after.
const KEYS = { mode: "theme", light: "theme-light", dark: "theme-dark" } as const;
const systemDark = matchMedia("(prefers-color-scheme: dark)");

/** The theme picked for one side, or its default if none was or it's no longer offered. */
function picked(dark: boolean): Theme["id"] {
	const id = localStorage.getItem(dark ? KEYS.dark : KEYS.light);
	return THEMES.find((t) => t.id === id && t.dark === dark)?.id ?? (dark ? "dark" : "light");
}

function resolve() {
	const stored = localStorage.getItem(KEYS.mode);
	const mode = MODES.find((m) => m === stored) ?? "system";
	const light = picked(false);
	const dark = picked(true);
	const isDark = mode === "dark" || (mode === "system" && systemDark.matches);
	return { mode, light, dark, isDark, active: isDark ? dark : light };
}

/** `light` and `dark` are the picks for each side; `active` is the one showing. */
export const appearance = createStore(resolve());

function apply() {
	const next = resolve();
	const root = document.documentElement;
	if (root.dataset.theme !== next.active || root.classList.contains("dark") !== next.isDark) {
		// Swap every colour at once, rather than letting transitions fade some of them.
		const freeze = document.head.appendChild(document.createElement("style"));
		freeze.textContent = "*,*::before,*::after{transition:none!important}";
		root.dataset.theme = next.active;
		root.classList.toggle("dark", next.isDark);
		// Restyle while frozen, then thaw.
		getComputedStyle(root).getPropertyValue("color");
		setTimeout(() => freeze.remove());
	}
	paintThemeColor();
	appearance.setState(() => next);
}

const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');

/**
 * What browsers paint around the app (an installed app's title bar, Android's status bar) matches the page behind
 * it. Read back as hex through a canvas, since some themes are written in oklch(), which not every browser takes here.
 */
function paintThemeColor() {
	const ctx = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true });
	if (!ctx || !themeColor) return;
	ctx.fillStyle = getComputedStyle(document.body).backgroundColor;
	ctx.fillRect(0, 0, 1, 1);
	const [r = 0, g = 0, b = 0, alpha = 0] = ctx.getImageData(0, 0, 1, 1).data;
	// Transparent until the styles load: the dev server adds them from a script that can run after this one.
	if (alpha < 255) return;
	themeColor.content = `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

export function setMode(mode: Mode) {
	if (mode === "system") localStorage.removeItem(KEYS.mode);
	else localStorage.setItem(KEYS.mode, mode);
	apply();
}

/** Picks the theme for its own side; it shows now if that side is showing. */
export function setTheme(theme: Theme) {
	localStorage.setItem(theme.dark ? KEYS.dark : KEYS.light, theme.id);
	apply();
}

// Corrects a theme that's no longer offered. Then follow the OS while on System, and other tabs when they pick.
apply();
window.addEventListener("load", paintThemeColor, { once: true });
systemDark.addEventListener("change", apply);
window.addEventListener("storage", (e) => {
	if (e.key === KEYS.mode || e.key === KEYS.light || e.key === KEYS.dark) apply();
});
