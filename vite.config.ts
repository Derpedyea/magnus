import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	// `@/` → src/, from tsconfig.app.json (shadcn's import alias).
	resolve: { tsconfigPaths: true },
	plugins: [
		// Generates src/routeTree.gen.ts from src/routes/ and code-splits each route. Must run before react().
		tanstackRouter({ target: "react", autoCodeSplitting: true }),
		react(),
		tailwindcss(),
		cloudflare(),
	],
});
