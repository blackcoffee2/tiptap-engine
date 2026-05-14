// ============================================================================
// WebView Adapter
//
// Handles communication between the engine (running inside a headless WebView)
// and the native port (Flutter, Swift, Kotlin, etc.).
//
// Platform detection:
// - iOS:     window.webkit.messageHandlers.TiptapEngine.postMessage (outbound)
//            Native side calls TiptapEngine.handleCommand() via evaluateJavaScript (inbound)
// - Android: window.TiptapBridge.postMessage (outbound)
//            Native side calls TiptapEngine.handleCommand() via evaluateJavascript (inbound)
// - Browser: window.postMessage (both directions, for testing/development)
// ============================================================================

import { BaseAdapter } from "./base";
import type { Command, Event, Response } from "../types/protocol";

/**
 * Extend the global Window interface to declare the platform-specific
 * bridge objects that native hosts inject into the WebView.
 */
declare global {
  interface Window {
    /**
     * iOS bridge: WKWebView injects this object. Each named handler
     * corresponds to a WKScriptMessageHandler on the native side.
     */
    webkit?: {
      messageHandlers?: {
        TiptapEngine?: {
          postMessage(message: string): void;
        };
      };
    };

    /**
     * Android bridge: injected via WebView.addJavascriptInterface().
     * Methods annotated with @JavascriptInterface on the Kotlin/Java
     * side become callable from JS.
     */
    TiptapBridge?: {
      postMessage(message: string): void;
    };

    /**
     * Global namespace for the engine's inbound API. The native side
     * calls these functions via evaluateJavaScript to send commands
     * into the engine.
     */
    TiptapEngine?: {
      handleCommand(commandJson: string): void;
    };
  }
}

type Platform = "ios" | "android" | "browser";

export class WebViewAdapter extends BaseAdapter {
  private platform: Platform;
  private boundMessageListener: ((event: MessageEvent) => void) | null = null;

  constructor() {
    super();
    this.platform = this.detectPlatform();
  }

  /**
   * Detect which platform we're running on by checking for
   * platform-specific bridge objects on the window.
   */
  private detectPlatform(): Platform {
    if (
      typeof window !== "undefined" &&
      window.webkit?.messageHandlers?.TiptapEngine
    ) {
      return "ios";
    }

    if (typeof window !== "undefined" && window.TiptapBridge) {
      return "android";
    }

    return "browser";
  }

  /**
   * Send an event or response to the native port. Serializes the message
   * to JSON and delivers it through the platform-appropriate channel.
   */
  send(message: Event | Response): void {
    const json = JSON.stringify(message);

    switch (this.platform) {
      case "ios":
        window.webkit!.messageHandlers!.TiptapEngine!.postMessage(json);
        break;

      case "android":
        window.TiptapBridge!.postMessage(json);
        break;

      case "browser":
        /**
         * In browser mode, we post to the parent window (for iframe-based
         * testing) or to self (for same-window testing). The message is
         * wrapped in a typed envelope so listeners can filter for it.
         */
        window.postMessage({ source: "tiptap-engine", message }, "*");
        break;
    }
  }

  /**
   * Register the global TiptapEngine.handleCommand function that the
   * native side calls via evaluateJavaScript, and (in browser mode)
   * start listening for postMessage events.
   */
  initialize(): void {
    /**
     * Register the global inbound handler. On iOS and Android, the native
     * side calls: evaluateJavaScript('TiptapEngine.handleCommand("...")')
     * where the argument is a JSON-encoded command string.
     */
    window.TiptapEngine = {
      handleCommand: (commandJson: string) => {
        try {
          const command = JSON.parse(commandJson) as Command;
          this.dispatchCommand(command);
        } catch (error) {
          console.error(
            "[TiptapEngine] Failed to parse incoming command:",
            error
          );
        }
      },
    };

    /**
     * In browser mode, also listen for postMessage events so commands
     * can be sent via window.postMessage from test harnesses or iframes.
     */
    if (this.platform === "browser") {
      this.boundMessageListener = (event: MessageEvent) => {
        const data = event.data;
        if (
          data &&
          typeof data === "object" &&
          data.source === "tiptap-port" &&
          data.message
        ) {
          try {
            const command = data.message as Command;
            this.dispatchCommand(command);
          } catch (error) {
            console.error(
              "[TiptapEngine] Failed to process browser message:",
              error
            );
          }
        }
      };
      window.addEventListener("message", this.boundMessageListener);
    }
  }

  /**
   * Remove the global handler and stop listening for messages.
   */
  destroy(): void {
    if (window.TiptapEngine) {
      delete window.TiptapEngine;
    }

    if (this.boundMessageListener) {
      window.removeEventListener("message", this.boundMessageListener);
      this.boundMessageListener = null;
    }
  }
}
