// ============================================================================
// Test Adapter
//
// An in-memory adapter for unit tests. Instead of communicating over
// stdin/stdout or WebView bridges, it collects all outbound messages
// in an array and provides helper methods to send commands and wait
// for specific responses or events.
// ============================================================================

import { BaseAdapter } from "../src/adapters/base";
import type {
  Command,
  Event,
  Response,
  StateChangedEvent,
  SchemaReadyEvent,
} from "../src/types/protocol";

/**
 * Union of all outbound message types (events and responses).
 */
export type OutboundMessage = Event | Response;

export class TestAdapter extends BaseAdapter {
  /**
   * All messages sent by the engine, in order. Tests can inspect
   * this array to verify the engine's behavior.
   */
  public messages: OutboundMessage[] = [];

  /**
   * Listeners waiting for specific message conditions. Used by
   * the waitFor* helper methods.
   */
  private waiters: Array<{
    predicate: (msg: OutboundMessage) => boolean;
    resolve: (msg: OutboundMessage) => void;
  }> = [];

  send(message: Event | Response): void {
    this.messages.push(message);

    /**
     * Check if any waiters are satisfied by this message.
     * Resolve and remove matched waiters.
     */
    const satisfied: number[] = [];
    for (let i = 0; i < this.waiters.length; i++) {
      if (this.waiters[i].predicate(message)) {
        this.waiters[i].resolve(message);
        satisfied.push(i);
      }
    }

    /**
     * Remove satisfied waiters in reverse order to avoid index shifting.
     */
    for (let i = satisfied.length - 1; i >= 0; i--) {
      this.waiters.splice(satisfied[i], 1);
    }
  }

  initialize(): void {
    /* No-op for test adapter — no external channel to set up */
  }

  destroy(): void {
    this.messages = [];
    this.waiters = [];
  }

  // ==========================================================================
  // Test Helpers
  // ==========================================================================

  /**
   * Send a command into the engine as if it came from the port.
   * This calls the registered command handler directly.
   */
  sendCommand(command: Command): void {
    this.dispatchCommand(command);
  }

  /**
   * Wait for a message that matches the given predicate.
   * Returns a promise that resolves with the matching message.
   * Times out after the specified duration.
   */
  waitFor(
    predicate: (msg: OutboundMessage) => boolean,
    timeoutMs = 5000
  ): Promise<OutboundMessage> {
    /**
     * Check if any already-collected message matches. This handles
     * the case where the event was emitted synchronously before
     * the test called waitFor.
     */
    const existing = this.messages.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("waitFor timed out"));
      }, timeoutMs);

      this.waiters.push({
        predicate,
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      });
    });
  }

  /**
   * Wait for a response to a specific command by id.
   */
  waitForResponse(commandId: string): Promise<Response> {
    return this.waitFor(
      (msg) => msg.type === "response" && (msg as Response).id === commandId
    ) as Promise<Response>;
  }

  /**
   * Wait for a specific event by name.
   */
  waitForEvent(eventName: string): Promise<Event> {
    return this.waitFor(
      (msg) => msg.type === "event" && (msg as Event).name === eventName
    ) as Promise<Event>;
  }

  /**
   * Get all events with a specific name from the collected messages.
   */
  getEvents(eventName: string): Event[] {
    return this.messages.filter(
      (msg) => msg.type === "event" && (msg as Event).name === eventName
    ) as Event[];
  }

  /**
   * Get the most recent stateChanged event.
   */
  getLastStateChanged(): StateChangedEvent | null {
    const events = this.getEvents("stateChanged") as StateChangedEvent[];
    return events.length > 0 ? events[events.length - 1] : null;
  }

  /**
   * Get the schemaReady event (should be exactly one).
   */
  getSchemaReady(): SchemaReadyEvent | null {
    const events = this.getEvents("schemaReady") as SchemaReadyEvent[];
    return events.length > 0 ? events[0] : null;
  }

  /**
   * Clear all collected messages. Useful between test assertions
   * when you want to check only new messages.
   */
  clearMessages(): void {
    this.messages = [];
  }

  /**
   * Helper to create a command object with a unique id.
   */
  static makeCommand(
    name: string,
    payload: Record<string, unknown> = {}
  ): Command {
    return {
      type: "command",
      id: `test_${name}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      payload,
    } as Command;
  }
}
