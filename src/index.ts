// ============================================================================
// Entry Point
//
// Detects the runtime environment and initializes the appropriate adapter
// and engine. This file is the single entry point for the IIFE bundle.
//
// Environment detection:
// - Node.js: process.stdin/stdout exist → use NodeAdapter
// - Browser/WebView: window exists → use WebViewAdapter
//
// The engine starts listening immediately after initialization. The port
// sends an "init" command to create the Tiptap editor instance.
// ============================================================================

import { TiptapEngine } from "./core/engine";
import { WebViewAdapter } from "./adapters/webview";
import { NodeAdapter } from "./adapters/node";
import type { BaseAdapter } from "./adapters/base";

function detectEnvironment(): "node" | "webview" {
  /**
   * Check for Node.js by looking for process.stdin. This is more reliable
   * than checking for window, since jsdom (used in tests) provides a window
   * object but still runs in Node.js.
   */
  if (
    typeof process !== "undefined" &&
    process.stdin &&
    process.stdout &&
    typeof window === "undefined"
  ) {
    return "node";
  }

  return "webview";
}

function bootstrap(): void {
  const environment = detectEnvironment();

  let adapter: BaseAdapter;

  if (environment === "node") {
    adapter = new NodeAdapter();
  } else {
    adapter = new WebViewAdapter();
  }

  /**
   * Create the engine and wire it to the adapter. The engine registers
   * its command handler with the adapter during construction.
   */
  const _engine = new TiptapEngine(adapter);

  /**
   * Start listening for incoming messages. For WebView, this registers
   * the global TiptapEngine.handleCommand function. For Node, this
   * starts reading from stdin.
   */
  adapter.initialize();

  /**
   * In browser/WebView mode, store a reference on the window so the
   * engine can be accessed for debugging. This does not affect the
   * message-based communication — it's purely for developer tools.
   */
  if (environment === "webview" && typeof window !== "undefined") {
    (window as unknown as Record<string, unknown>).__tiptapEngineInstance =
      _engine;
  }
}

bootstrap();
