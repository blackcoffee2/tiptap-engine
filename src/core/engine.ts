// ============================================================================
// Engine
//
// The main class that wraps a Tiptap Editor instance. It receives commands
// from the adapter, dispatches them to Tiptap, and emits state change
// events back through the adapter.
//
// The engine is the single orchestration point: it owns the editor lifecycle,
// hooks into transactions, serializes state, and manages command execution.
// ============================================================================

import { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import type { BaseAdapter } from "../adapters/base";
import {
  resolveExtensions,
  type ExtensionRequest,
} from "../extensions/registry";
import {
  serializeDocument,
  serializeSelection,
  getActiveMarks,
  getActiveNodes,
  getStoredMarks,
  getDecorations,
} from "./state-serializer";
import { inspectNodeTypes, inspectMarkTypes } from "./schema-inspector";
import { discoverCommands } from "./command-registry";
import type {
  Command,
  Response,
  Event,
  StateChangedEvent,
  ContentChangedEvent,
  SelectionChangedEvent,
  SchemaReadyEvent,
  ReadyEvent,
  ErrorEvent,
  CommandState,
  SchemaMetadata,
} from "../types/protocol";

/**
 * Computes the command states map that drives toolbar UI. For each
 * discovered command, determines whether it can execute and whether
 * its associated mark/node is active at the current selection.
 */
function computeCommandStates(editor: Editor): Record<string, CommandState> {
  const states: Record<string, CommandState> = {};

  /**
   * Use the editor.can() chain to check if each command can execute.
   * The can() proxy returns true/false for each command without
   * actually executing it.
   */
  const canProxy = editor.can();

  /**
   * We iterate over all known commands. For commands that have an
   * associated mark or node, we also check isActive.
   */
  const commandNames = Object.keys(editor.commands);

  for (const name of commandNames) {
    let canExec = false;
    let isActive = false;

    /**
     * Check canExec by calling the command through the can() proxy.
     * Some commands require arguments, so we wrap in try/catch and
     * default to false on failure.
     */
    try {
      const canMethod = (canProxy as Record<string, Function>)[name];
      if (typeof canMethod === "function") {
        canExec = canMethod() === true;
      }
    } catch {
      canExec = false;
    }

    /**
     * Check isActive for marks and nodes. We try both — if the name
     * matches a mark type or node type in the schema, editor.isActive()
     * will return a meaningful result.
     */
    try {
      isActive = editor.isActive(name);
    } catch {
      isActive = false;
    }

    const state: CommandState = { canExec, isActive };

    /**
     * Special handling for undo/redo: extract the stack depth from
     * the history plugin state. This allows the port to show a badge
     * count on undo/redo buttons.
     */
    if (name === "undo" || name === "redo") {
      try {
        const historyState = findHistoryState(editor);
        if (historyState) {
          if (name === "undo") {
            state.depth = historyState.done?.items?.length ?? 0;
          } else {
            state.depth = historyState.undone?.items?.length ?? 0;
          }
        }
      } catch {
        /* History plugin may not be loaded */
      }
    }

    states[name] = state;
  }

  return states;
}

/**
 * Attempt to find the history plugin state in the editor. The history
 * plugin stores undo/redo stacks that we need for depth counts.
 */
function findHistoryState(
  editor: Editor
): {
  done?: { items?: { length: number } };
  undone?: { items?: { length: number } };
} | null {
  const state = editor.state;

  /**
   * The history plugin registers itself with a specific plugin key.
   * We search through all plugins to find it.
   */
  for (const plugin of state.plugins) {
    const pluginState = plugin.getState(state);
    if (
      pluginState &&
      typeof pluginState === "object" &&
      "done" in pluginState &&
      "undone" in pluginState
    ) {
      return pluginState as {
        done?: { items?: { length: number } };
        undone?: { items?: { length: number } };
      };
    }
  }

  return null;
}

export class TiptapEngine {
  private adapter: BaseAdapter;
  private editor: Editor | null = null;
  private schemaMetadata: SchemaMetadata | null = null;

  /**
   * Track the last document JSON string to determine whether a
   * transaction changed the document content (for contentChanged events)
   * vs only changing the selection (for selectionChanged events).
   */
  private lastDocJson: string = "";

  constructor(adapter: BaseAdapter) {
    this.adapter = adapter;
    this.adapter.onCommand(this.handleCommand.bind(this));
  }

  /**
   * Central command dispatcher. Routes incoming commands to the
   * appropriate handler method and sends back a response.
   */
  private handleCommand(command: Command): void {
    try {
      switch (command.name) {
        case "init":
          this.handleInit(command);
          break;
        case "destroy":
          this.handleDestroy(command);
          break;
        case "setEditable":
          this.handleSetEditable(command);
          break;
        case "setContent":
          this.handleSetContent(command);
          break;
        case "getContent":
          this.handleGetContent(command);
          break;
        case "insertContentAt":
          this.handleInsertContentAt(command);
          break;
        case "insertText":
          this.handleInsertText(command);
          break;
        case "deleteRange":
          this.handleDeleteRange(command);
          break;
        case "exec":
          this.handleExec(command);
          break;
        case "setTextSelection":
          this.handleSetTextSelection(command);
          break;
        case "setNodeSelection":
          this.handleSetNodeSelection(command);
          break;
        case "selectAll":
          this.handleSelectAll(command);
          break;
        case "focus":
          this.handleFocus(command);
          break;
        case "blur":
          this.handleBlur(command);
          break;
        case "getState":
          this.handleGetState(command);
          break;
        case "isActive":
          this.handleIsActive(command);
          break;
        case "canExec":
          this.handleCanExec(command);
          break;
        case "getAttributes":
          this.handleGetAttributes(command);
          break;
        default: {
          const unknownCommand = command as { id: string; name: string };
          this.sendResponse(unknownCommand.id, false, undefined, {
            code: "UNKNOWN_COMMAND",
            message: `Unknown command: ${unknownCommand.name}`,
          });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      this.sendResponse(command.id, false, undefined, {
        code: "COMMAND_FAILED",
        message,
      });
      this.emitError("COMMAND_FAILED", message, command.id);
    }
  }

  // ==========================================================================
  // Lifecycle Commands
  // ==========================================================================

  private handleInit(command: Command): void {
    if (this.editor) {
      this.sendResponse(command.id, false, undefined, {
        code: "ALREADY_INITIALIZED",
        message: "Engine is already initialized. Call destroy first.",
      });
      return;
    }

    const payload = command.payload as {
      extensions?: ExtensionRequest[];
      content?: Record<string, unknown> | string;
      editable?: boolean;
    };

    /**
     * Resolve extension names to configured Tiptap extension instances.
     * The registry handles dependency resolution and default extensions.
     */
    const extensions = resolveExtensions(payload.extensions);

    /**
     * Determine the mount element. In a WebView, we look for the
     * hidden #editor div. In Node.js (testing), we create a detached
     * element if a DOM is available, or pass undefined.
     */
    const element =
      typeof document !== "undefined"
        ? document.getElementById("editor") || document.createElement("div")
        : undefined;

    this.editor = new Editor({
      element: element || undefined,
      extensions,
      content: payload.content || "",
      editable: payload.editable !== false,

      /**
       * Hook into every transaction to emit state updates.
       * This is the primary mechanism by which the engine pushes
       * state to the port.
       */
      onTransaction: ({ transaction }) => {
        this.onTransaction(transaction);
      },
    });

    /**
     * Build schema metadata for the schemaReady event. This includes
     * all node types, mark types, and discovered commands.
     */
    this.schemaMetadata = {
      nodes: inspectNodeTypes(this.editor.schema),
      marks: inspectMarkTypes(this.editor.schema),
      commands: discoverCommands(this.editor),
    };

    /**
     * Initialize the last document JSON for change detection.
     */
    this.lastDocJson = JSON.stringify(this.editor.getJSON());

    /**
     * Emit schemaReady before ready, as specified in the protocol.
     * This allows the port to set up its toolbar before the editor
     * signals it's ready for interaction.
     */
    const schemaReadyEvent: SchemaReadyEvent = {
      type: "event",
      name: "schemaReady",
      payload: this.schemaMetadata,
    };
    this.adapter.send(schemaReadyEvent);

    const readyEvent: ReadyEvent = {
      type: "event",
      name: "ready",
      payload: {},
    };
    this.adapter.send(readyEvent);

    /**
     * Emit an initial stateChanged event so the port receives the
     * full document state immediately after initialization. In some
     * Tiptap versions, the editor may not fire an onTransaction
     * callback during construction, so we emit this explicitly to
     * guarantee the port always gets the initial state.
     */
    const initialState: StateChangedEvent = {
      type: "event",
      name: "stateChanged",
      payload: this.buildStatePayload(this.editor),
    };
    this.adapter.send(initialState);

    this.sendResponse(command.id, true);
  }

  private handleDestroy(command: Command): void {
    if (this.editor) {
      this.editor.destroy();
      this.editor = null;
      this.schemaMetadata = null;
      this.lastDocJson = "";
    }
    this.sendResponse(command.id, true);
  }

  private handleSetEditable(command: Command): void {
    this.requireEditor(command.id, (editor) => {
      const { editable } = command.payload as { editable: boolean };
      editor.setEditable(editable);
      this.sendResponse(command.id, true);
    });
  }

  // ==========================================================================
  // Content Commands
  // ==========================================================================

  private handleSetContent(command: Command): void {
    this.requireEditor(command.id, (editor) => {
      const payload = command.payload as {
        content: Record<string, unknown> | string;
        emitUpdate?: boolean;
      };
      editor.commands.setContent(payload.content as string, {
        emitUpdate: payload.emitUpdate !== false,
      });
      this.sendResponse(command.id, true);
    });
  }

  private handleGetContent(command: Command): void {
    this.requireEditor(command.id, (editor) => {
      const { format } = command.payload as { format: string };

      let content: unknown;
      switch (format) {
        case "json":
          content = editor.getJSON();
          break;
        case "html":
          content = editor.getHTML();
          break;
        case "text":
          content = editor.getText();
          break;
        default:
          this.sendResponse(command.id, false, undefined, {
            code: "INVALID_FORMAT",
            message: `Unknown content format: ${format}. Use "json", "html", or "text".`,
          });
          return;
      }

      this.sendResponse(command.id, true, { content });
    });
  }

  private handleInsertContentAt(command: Command): void {
    this.requireEditor(command.id, (editor) => {
      const payload = command.payload as {
        position: number | { from: number; to: number };
        content: Record<string, unknown> | string;
      };
      editor.commands.insertContentAt(
        payload.position,
        payload.content as string
      );
      this.sendResponse(command.id, true);
    });
  }

  // ==========================================================================
  // Text Input Commands
  // ==========================================================================

  private handleInsertText(command: Command): void {
    this.requireEditor(command.id, (editor) => {
      const payload = command.payload as {
        text: string;
        range?: { from: number; to: number };
      };

      if (payload.range) {
        /**
         * When a range is specified, we create a transaction that replaces
         * the range with the new text. This is used when the port knows
         * the exact range (e.g., after composition commit).
         */
        editor
          .chain()
          .focus()
          .insertContentAt(payload.range, payload.text)
          .run();
      } else {
        /**
         * Without a range, insert at the current selection. The command()
         * call handles replacing selected text naturally.
         */
        editor.chain().focus().insertContent(payload.text).run();
      }

      this.sendResponse(command.id, true);
    });
  }

  private handleDeleteRange(command: Command): void {
    this.requireEditor(command.id, (editor) => {
      const payload = command.payload as {
        range?: { from: number; to: number };
      };

      if (payload.range) {
        editor.chain().focus().deleteRange(payload.range).run();
      } else {
        /**
         * No range specified: perform a backspace-style deletion.
         * This deletes the character before the cursor or the current selection.
         */
        const { from, to, empty } = editor.state.selection;
        if (empty) {
          if (from > 0) {
            editor
              .chain()
              .focus()
              .deleteRange({ from: from - 1, to: from })
              .run();
          }
        } else {
          editor.chain().focus().deleteRange({ from, to }).run();
        }
      }

      this.sendResponse(command.id, true);
    });
  }

  // ==========================================================================
  // Generic Command Execution
  // ==========================================================================

  private handleExec(command: Command): void {
    this.requireEditor(command.id, (editor) => {
      const payload = command.payload as {
        command: string;
        args?: Record<string, unknown>;
      };

      const cmdName = payload.command;
      const cmdArgs = payload.args;

      /**
       * Access the command through the chain API. We use focus() to
       * ensure the editor has logical focus before executing.
       */
      const chain = editor.chain().focus();
      const cmdFn = (chain as Record<string, Function>)[cmdName];

      if (typeof cmdFn !== "function") {
        this.sendResponse(command.id, false, undefined, {
          code: "UNKNOWN_EXEC_COMMAND",
          message: `Command "${cmdName}" is not available.`,
        });
        return;
      }

      /**
       * Execute the command. If args are provided, pass them as the
       * first argument (Tiptap commands typically take an options object).
       * If no args, call with no arguments.
       */
      const result = cmdArgs
        ? cmdFn.call(chain, cmdArgs).run()
        : cmdFn.call(chain).run();

      this.sendResponse(command.id, true, { executed: result });
    });
  }

  // ==========================================================================
  // Selection Commands
  // ==========================================================================

  private handleSetTextSelection(command: Command): void {
    this.requireEditor(command.id, (editor) => {
      const payload = command.payload as {
        anchor: number;
        head?: number;
      };

      const position =
        payload.head !== undefined
          ? {
              from: Math.min(payload.anchor, payload.head),
              to: Math.max(payload.anchor, payload.head),
            }
          : payload.anchor;

      editor.commands.setTextSelection(position);
      this.sendResponse(command.id, true);
    });
  }

  private handleSetNodeSelection(command: Command): void {
    this.requireEditor(command.id, (editor) => {
      const { position } = command.payload as { position: number };
      editor.commands.setNodeSelection(position);
      this.sendResponse(command.id, true);
    });
  }

  private handleSelectAll(command: Command): void {
    this.requireEditor(command.id, (editor) => {
      editor.commands.selectAll();
      this.sendResponse(command.id, true);
    });
  }

  private handleFocus(command: Command): void {
    this.requireEditor(command.id, (editor) => {
      const payload = command.payload as {
        position?: "start" | "end" | "all" | number;
      };
      editor.commands.focus(payload.position);
      this.sendResponse(command.id, true);
    });
  }

  private handleBlur(command: Command): void {
    this.requireEditor(command.id, (editor) => {
      editor.commands.blur();
      this.sendResponse(command.id, true);
    });
  }

  // ==========================================================================
  // Query Commands
  // ==========================================================================

  private handleGetState(command: Command): void {
    this.requireEditor(command.id, (editor) => {
      const statePayload = this.buildStatePayload(editor);
      this.sendResponse(command.id, true, statePayload);
    });
  }

  private handleIsActive(command: Command): void {
    this.requireEditor(command.id, (editor) => {
      const payload = command.payload as {
        name: string;
        attrs?: Record<string, unknown>;
      };
      const active = payload.attrs
        ? editor.isActive(payload.name, payload.attrs)
        : editor.isActive(payload.name);
      this.sendResponse(command.id, true, { active });
    });
  }

  private handleCanExec(command: Command): void {
    this.requireEditor(command.id, (editor) => {
      const payload = command.payload as {
        command: string;
        args?: Record<string, unknown>;
      };

      let canExec = false;
      try {
        const canProxy = editor.can().chain().focus();
        const cmdFn = (canProxy as Record<string, Function>)[payload.command];
        if (typeof cmdFn === "function") {
          canExec = payload.args
            ? cmdFn.call(canProxy, payload.args).run() === true
            : cmdFn.call(canProxy).run() === true;
        }
      } catch {
        canExec = false;
      }

      this.sendResponse(command.id, true, { canExec });
    });
  }

  private handleGetAttributes(command: Command): void {
    this.requireEditor(command.id, (editor) => {
      const { name } = command.payload as { name: string };
      const attrs = editor.getAttributes(name);
      this.sendResponse(command.id, true, { attrs });
    });
  }

  // ==========================================================================
  // Transaction Handling
  // ==========================================================================

  /**
   * Called on every ProseMirror transaction. Determines what changed and
   * emits the appropriate events (stateChanged, contentChanged, selectionChanged).
   */
  private onTransaction(_transaction: Transaction): void {
    if (!this.editor) {
      return;
    }

    const editor = this.editor;
    const statePayload = this.buildStatePayload(editor);

    /**
     * Detect whether the document content changed by comparing the
     * serialized document JSON. This is cheaper than deep comparison
     * for typical-sized documents.
     */
    const currentDocJson = JSON.stringify(statePayload.doc);
    const docChanged = currentDocJson !== this.lastDocJson;

    /**
     * Always emit stateChanged with the full state.
     * This is the primary event ports use to re-render.
     */
    const stateChangedEvent: StateChangedEvent = {
      type: "event",
      name: "stateChanged",
      payload: statePayload,
    };
    this.adapter.send(stateChangedEvent);

    if (docChanged) {
      /**
       * Document content changed — emit contentChanged for auto-save
       * and other content-sensitive listeners.
       */
      this.lastDocJson = currentDocJson;

      const contentChangedEvent: ContentChangedEvent = {
        type: "event",
        name: "contentChanged",
        payload: { doc: statePayload.doc },
      };
      this.adapter.send(contentChangedEvent);
    } else {
      /**
       * Selection-only change — emit the lighter selectionChanged event
       * that omits the document tree.
       */
      const selectionChangedEvent: SelectionChangedEvent = {
        type: "event",
        name: "selectionChanged",
        payload: {
          selection: statePayload.selection,
          activeMarks: statePayload.activeMarks,
          activeNodes: statePayload.activeNodes,
          commandStates: statePayload.commandStates,
        },
      };
      this.adapter.send(selectionChangedEvent);
    }
  }

  /**
   * Build the full state payload that's included in stateChanged events
   * and getState responses.
   */
  private buildStatePayload(editor: Editor): StateChangedEvent["payload"] {
    return {
      doc: serializeDocument(editor.state),
      selection: serializeSelection(editor.state),
      activeMarks: getActiveMarks(editor.state),
      activeNodes: getActiveNodes(editor.state),
      commandStates: computeCommandStates(editor),
      decorations: getDecorations(editor.state),
      storedMarks: getStoredMarks(editor.state),
      editable: editor.isEditable,
    };
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  /**
   * Guard that ensures the editor is initialized before processing a command.
   * Sends an error response and returns if the editor is null.
   */
  private requireEditor(commandId: string, fn: (editor: Editor) => void): void {
    if (!this.editor) {
      this.sendResponse(commandId, false, undefined, {
        code: "NOT_INITIALIZED",
        message: "Engine is not initialized. Send an init command first.",
      });
      return;
    }
    fn(this.editor);
  }

  /**
   * Send a response message correlated to a command by id.
   */
  private sendResponse(
    id: string,
    success: boolean,
    payload?: unknown,
    error?: { code: string; message: string }
  ): void {
    const response: Response = {
      type: "response",
      id,
      success,
      payload,
      error,
    };
    this.adapter.send(response);
  }

  /**
   * Emit an error event. Used for errors that aren't direct responses
   * to a specific command, or as a supplementary notification.
   */
  private emitError(code: string, message: string, commandId?: string): void {
    const errorEvent: ErrorEvent = {
      type: "event",
      name: "error",
      payload: { code, message, commandId },
    };
    this.adapter.send(errorEvent);
  }
}
