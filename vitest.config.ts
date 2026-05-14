import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * Use jsdom to provide a browser-like environment for tests.
     * ProseMirror and Tiptap require DOM APIs (document.createElement,
     * Node, etc.) to function. jsdom gives us these without needing
     * a real browser.
     */
    environment: "jsdom",

    globals: true,

    include: ["test/**/*.test.ts"],

    /**
     * Increase the test timeout since extension initialization
     * involves creating a full Tiptap editor with all extensions.
     */
    testTimeout: 10000,
  },
});
