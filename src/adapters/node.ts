// ============================================================================
// Node.js Adapter
//
// Uses process stdin/stdout with newline-delimited JSON (NDJSON) for
// communication. This adapter enables headless testing and CI without
// a browser or WebView — commands are piped in via stdin and events
// are emitted on stdout.
//
// Protocol: one JSON message per line. Messages are separated by newlines.
// Each line is a complete JSON object (no multi-line JSON).
// ============================================================================

import { BaseAdapter } from "./base";
import type { Command, Event, Response } from "../types/protocol";

export class NodeAdapter extends BaseAdapter {
  private inputBuffer = "";
  private boundDataHandler: ((chunk: Buffer) => void) | null = null;

  /**
   * Send an event or response to the port by writing a JSON line to stdout.
   * Each message is followed by a newline to maintain the NDJSON format.
   */
  send(message: Event | Response): void {
    const json = JSON.stringify(message);
    process.stdout.write(json + "\n");
  }

  /**
   * Start reading from stdin. Incoming data is buffered and split on
   * newlines. Each complete line is parsed as a JSON command and
   * dispatched to the engine.
   */
  initialize(): void {
    if (!process.stdin) {
      console.error("[TiptapEngine] No stdin available in this environment");
      return;
    }

    process.stdin.setEncoding("utf-8");

    this.boundDataHandler = (chunk: Buffer) => {
      this.inputBuffer += chunk.toString();

      /**
       * Process all complete lines in the buffer. A complete line ends
       * with a newline character. Incomplete lines (the last segment
       * after the final newline) remain in the buffer for the next chunk.
       */
      const lines = this.inputBuffer.split("\n");
      this.inputBuffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
          continue;
        }

        try {
          const command = JSON.parse(trimmed) as Command;
          this.dispatchCommand(command);
        } catch (error) {
          console.error("[TiptapEngine] Failed to parse stdin message:", error);
        }
      }
    };

    process.stdin.on("data", this.boundDataHandler);
    process.stdin.resume();
  }

  /**
   * Stop reading from stdin and clear the input buffer.
   */
  destroy(): void {
    if (this.boundDataHandler && process.stdin) {
      process.stdin.removeListener("data", this.boundDataHandler);
      this.boundDataHandler = null;
    }
    this.inputBuffer = "";
  }
}
