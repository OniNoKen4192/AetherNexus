import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// root is web/; the build lands in dist/web, which is the only directory vite empties.
export default defineConfig({
  root: "web",
  base: "/",
  plugins: [preact()],
  build: { outDir: "../dist/web", emptyOutDir: true, assetsDir: "assets", target: "es2022" },
});
