// ============================================================================
// Base Adapter Interface
//
// Adapters handle the transport layer between the engine and the port.
// Each platform (WebView, Node.js, browser postMessage) has its own
// adapter implementation, but the engine interacts with all of them
// through this common interface.
// ============================================================================

import type { Command, Event, Response } from "../types/protocol";

/**
 * Handler function that the engine registers with the adapter to receive
 * incoming commands from the port.
 */
export type CommandHandler = (command: Command) => void;

/**
 * Abstract base class for all adapters. Subclasses implement the
 * platform-specific transport mechanism (postMessage, stdin/stdout, etc.).
 */
export abstract class BaseAdapter {
  protected commandHandler: CommandHandler | null = null;

  /**
   * Send an event or response from the engine to the port.
   * The adapter serializes the message and delivers it through
   * the platform-specific channel.
   */
  abstract send(message: Event | Response): void;

  /**
   * Register the command handler. The engine calls this once during
   * setup to receive all incoming commands from the port.
   * Only one handler is supported — subsequent calls replace the previous one.
   */
  onCommand(handler: CommandHandler): void {
    this.commandHandler = handler;
  }

  /**
   * Start listening for incoming messages on the platform-specific channel.
   * Called once during engine startup after the command handler is registered.
   */
  abstract initialize(): void;

  /**
   * Stop listening and clean up any platform-specific resources.
   * Called during engine shutdown.
   */
  abstract destroy(): void;

  /**
   * Dispatch an incoming command to the registered handler.
   * Subclasses call this after deserializing an incoming message.
   * Logs a warning if no handler is registered.
   */
  protected dispatchCommand(command: Command): void {
    if (this.commandHandler) {
      this.commandHandler(command);
    } else {
      console.warn(
        "[TiptapEngine] Received command but no handler is registered:",
        command.name
      );
    }
  }
}
