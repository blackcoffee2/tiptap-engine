import { defineConfig } from "vite";
import { resolve } from "path";
import { copyFileSync, mkdirSync } from "fs";

export default defineConfig({
  build: {
    lib: {
      /**
       * Entry point for the engine bundle. index.ts detects the runtime
       * environment and wires the correct adapter automatically.
       */
      entry: resolve(__dirname, "src/index.ts"),

      /**
       * IIFE format: the bundle self-executes when loaded. This is necessary
       * because headless WebViews don't have a module loader — the script
       * runs immediately and registers globals.
       */
      name: "TiptapEngine",
      formats: ["iife"],
      fileName: () => "tiptap-engine.js",
    },

    /**
     * All Tiptap and ProseMirror packages are inlined into the bundle.
     * The engine is fully self-contained with zero runtime imports.
     */
    rollupOptions: {
      output: {
        /**
         * Extend the global scope rather than replacing it. This ensures
         * the engine's global registration functions coexist with any
         * other globals the host environment defines.
         */
        extend: true,
      },
    },

    outDir: "dist",
    minify: "terser",
    sourcemap: true,

    /**
     * Targeting ES2020 keeps the output compact while supporting async/await,
     * optional chaining, and nullish coalescing natively. All modern iOS and
     * Android WebViews support ES2020.
     */
    target: "es2020",
  },

  plugins: [
    {
      name: "copy-shell-html",
      /**
       * After the bundle is written to dist/, copy the HTML shell alongside
       * it. The shell references tiptap-engine.js via a relative <script> tag,
       * so both files must live in the same directory.
       */
      closeBundle() {
        mkdirSync(resolve(__dirname, "dist"), { recursive: true });
        copyFileSync(
          resolve(__dirname, "src/shell/tiptap-engine.html"),
          resolve(__dirname, "dist/tiptap-engine.html")
        );
        copyFileSync(
          resolve(__dirname, "src/shell/test.html"),
          resolve(__dirname, "dist/test.html")
        );
      },
    },
  ],
});
