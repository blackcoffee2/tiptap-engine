// ============================================================================
// Engine
//
// The main class that wraps a Tiptap Editor instance. It receives commands
// from the adapter, dispatches them to Tiptap, and emits state change
// events back through the adapter.
//
// The engine is the single orchestration point: it owns the editor lifecycle,
// hooks into transactions, serializes state, and manages command execution.
//
// Performance instrumentation:
// This engine measures how it spends the JavaScript-side slice of each
// command's round-trip, so the port can subtract engine compute from the
// full send-to-response time it measures itself and isolate transport cost.
// A PhaseTimer (core/metrics.ts) records phase durations; the durations ride
// back on the Response (handle) and on stateChanged (the full build
// breakdown). Timing is always on — a permanent engine capability, not an
// opt-in diagnostic — but the timings field is attached only to messages
// where at least one phase was actually timed. The stateChanged event also
// carries a causedBy id correlating it to the command that produced it.
//
// commandStates timing:
// Measurement established that the per-keystroke engine cost is dominated by
// the canExec dry-run half of the command-state sweep — editor.can()[name]()
// run for every command on every transaction, where each call builds and
// discards a trial transaction. The sweep computes both canExec and isActive
// for every command. The can() and isActive() halves are timed separately
// (commandStatesCan / commandStatesActive) so that dominant cost stays visible
// in the overlay.
//
// Per-command emission coalescing:
// A single keystroke produces more than one ProseMirror transaction — the
// content insertion, plus follow-on transactions such as the trailing-node
// append (StarterKit's TrailingNode) or a selection/stored-mark settle. Each
// transaction fired onTransaction, which previously rebuilt and re-emitted the
// full state every time. Measurement showed the state build running about
// twice per command (the build sub-phases logged ~2x the count of command
// handles), doubling both engine compute and the number of stateChanged
// messages crossing the bridge per keystroke.
//
// To fix this without risking a document desync, emission is coalesced per
// command rather than per transaction. While a command is in flight, each
// onTransaction firing only marks the editor state dirty; the engine then
// builds and emits state ONCE, after the command handler's synchronous work
// (including all the transactions it dispatched) has completed, reflecting the
// final settled state. This is safe regardless of why a keystroke produces
// multiple transactions: whether a follow-on transaction changed the document
// (trailing node) or only the selection, emitting the final state once per
// command is always correct — the port receives exactly the end state, just
// once instead of once per intermediate transaction.
//
// Transactions that fire with NO command in flight (asynchronous plugin work,
// external edits) cannot be coalesced against a command boundary, so they fall
// back to emitting immediately, exactly as before. This preserves delivery of
// state changes the engine causes outside the command path.
// ============================================================================

import { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import {
  joinBackward,
  selectNodeBackward,
  deleteSelection,
} from "@tiptap/pm/commands";
import type { BaseAdapter } from "../adapters/base";
import { buildExtensions } from "../extensions/registry";
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
import { PhaseTimer, Phase } from "./metrics";
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
  Timings,
} from "../types/protocol";

/**
 * Computes the command states map that drives toolbar UI. For each
 * discovered command, determines whether it can execute (canExec) and whether
 * its associated mark/node is active at the current selection (isActive).
 *
 * When a timer is supplied, the two halves of the per-command work are
 * accumulated into separate sub-phases: commandStatesCan (the can() dry-run)
 * and commandStatesActive (the isActive check). The split is retained as
 * permanent instrumentation: the can() dry-run is the dominant half (it builds
 * and discards a trial transaction per command), so keeping the two timed
 * separately makes that cost visible if the sweep is ever revisited. The timer
 * does not change which commands are visited or what is computed — the same
 * can() and isActive() calls run in the same order regardless.
 */
function computeCommandStates(
  editor: Editor,
  timer?: PhaseTimer | null
): Record<string, CommandState> {
  const states: Record<string, CommandState> = {};

  /**
   * Use the editor.can() chain to check if each command can execute.
   * The can() proxy returns true/false for each command without
   * actually executing it.
   */
  const canProxy = editor.can();

  /**
   * We iterate over all known commands. For commands in the curated set we
   * also check canExec; for all commands we check isActive.
   */
  const commandNames = Object.keys(editor.commands);

  for (const name of commandNames) {
    let canExec = false;
    let isActive = false;

    /**
     * Check canExec by calling the command through the can() proxy. Some
     * commands require arguments, so we wrap in try/catch and default to
     * false on failure. Computed for every command; timed as the
     * commandStatesCan sub-phase — this is the dominant half of the sweep
     * (each call builds and discards a trial transaction), which is why the
     * split timing is retained even though both halves run for all commands.
     */
    const canStart = timer ? timer.clock() : 0;
    try {
      const canMethod = (canProxy as Record<string, Function>)[name];
      if (typeof canMethod === "function") {
        canExec = canMethod() === true;
      }
    } catch {
      canExec = false;
    }
    if (timer) {
      timer.add(Phase.commandStatesCan, timer.clock() - canStart);
    }

    /**
     * Check isActive for marks and nodes. We try both — if the name
     * matches a mark type or node type in the schema, editor.isActive()
     * will return a meaningful result. Timed as the commandStatesActive
     * sub-phase.
     */
    const activeStart = timer ? timer.clock() : 0;
    try {
      isActive = editor.isActive(name);
    } catch {
      isActive = false;
    }
    if (timer) {
      timer.add(Phase.commandStatesActive, timer.clock() - activeStart);
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
function findHistoryState(editor: Editor): {
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

  /**
   * The id of the command currently being handled, set on entry to
   * handleCommand and cleared on exit. The coalesced flush reads it to stamp
   * the causedBy field on the stateChanged it emits, correlating the state
   * change with the command that triggered it.
   *
   * A command handler runs synchronously, and the transactions a command
   * dispatches fire synchronously within that handler (ProseMirror applies
   * each transaction and the onTransaction callback runs before the command
   * returns). So while this field is set, any transaction observed is
   * attributable to this command. Transactions that fire outside a command
   * handler see a null field and are emitted immediately with no causedBy.
   */
  private currentCommandId: string | null = null;

  /**
   * The PhaseTimer for the command currently being handled, set on entry to
   * handleCommand. The coalesced flush uses it to record the state-build
   * sub-phases into the same timer whose handle phase the command handler is
   * measuring, so a single Response or stateChanged carries a coherent
   * breakdown. Null when no command is in flight.
   */
  private currentTimer: PhaseTimer | null = null;

  /**
   * Set by onTransaction while a command is in flight to mark that at least
   * one transaction occurred during this command and a state emission is
   * therefore owed. The command flush (flushPendingState) reads and clears it
   * after the handler's synchronous work completes, building and emitting
   * state once for however many transactions the command produced.
   *
   * This is the mechanism that coalesces a keystroke's multiple transactions
   * (content insert + trailing-node append + selection settle) into a single
   * build and a single emit.
   */
  private stateDirty: boolean = false;

  constructor(adapter: BaseAdapter) {
    this.adapter = adapter;
    this.adapter.onCommand(this.handleCommand.bind(this));
  }

  /**
   * Central command dispatcher. Routes incoming commands to the
   * appropriate handler method and sends back a response.
   *
   * Wraps the dispatch in a PhaseTimer: the handle phase spans from here to
   * the point each handler calls sendResponse. The timer, the command id, and
   * the per-command dirty flag are stored on the instance so onTransaction —
   * which fires synchronously inside a mutating handler — can mark state dirty
   * rather than emit, and so the single post-handler flush can build once,
   * emit once, and stamp the result with this command's id.
   *
   * Emission ordering within a command:
   *   1. handler body runs; each dispatched transaction fires onTransaction,
   *      which sets stateDirty (no emit yet);
   *   2. the handler calls sendResponse, closing the handle timer and sending
   *      the response;
   *   3. flushPendingState runs (still inside this synchronous call, with the
   *      command context intact), building and emitting the coalesced state
   *      once if dirty;
   *   4. finally clears the command context.
   *
   * The flush is placed after sendResponse so the handle phase measures the
   * command's execution work, and the build/emit is attributed to the same
   * timer via its own sub-phases. The response is sent before the state event,
   * preserving the existing response-then-event ordering the port already
   * sees.
   */
  private handleCommand(command: Command): void {
    const timer = new PhaseTimer();
    this.currentCommandId = command.id;
    this.currentTimer = timer;
    this.stateDirty = false;
    timer.start(Phase.handle);

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
        case "backspace":
          this.handleBackspace(command);
          break;
        case "enter":
          this.handleEnter(command);
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

      /**
       * Emit the coalesced state once, after the handler's synchronous work
       * (and therefore all transactions it dispatched) has completed. No-op
       * when the command produced no transaction (queries, no-op commands).
       */
      this.flushPendingState();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      this.sendResponse(command.id, false, undefined, {
        code: "COMMAND_FAILED",
        message,
      });
      this.emitError("COMMAND_FAILED", message, command.id);
    } finally {
      /**
       * Clear the per-command context so any transaction that fires after the
       * handler returns (async plugin work, a later input-rule tick) is not
       * attributed to this command — it will take the immediate-emit fallback
       * in onTransaction instead.
       */
      this.currentCommandId = null;
      this.currentTimer = null;
      this.stateDirty = false;
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
      content?: Record<string, unknown> | string;
      editable?: boolean;
    };

    /**
     * The engine runs with a fixed extension set (StarterKit + Image).
     * Extensions are not selectable or configurable from the port.
     */
    const extensions = buildExtensions();

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
       * Hook into every transaction to track state changes. During a command
       * this only marks state dirty (the command flush emits once); outside a
       * command it emits immediately.
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
     * Emit an initial stateChanged event so the port receives the full
     * document state immediately after initialization, in case editor
     * construction did not fire onTransaction. This is built without the
     * command timer and is not attributed via causedBy: it is the initial
     * full-state push, not a keystroke-style change.
     *
     * Clear any dirty flag set by transactions that fired during construction
     * first, so the post-handler flush does not emit a second, redundant
     * initial state: this explicit emit already carries the full state.
     */
    this.stateDirty = false;

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
  // Keyboard Action Commands
  // ==========================================================================

  /**
   * Execute ProseMirror's Backspace command chain directly. We run the
   * same sequence of commands that ProseMirror's keymap binds to the
   * Backspace key, but we invoke them as ProseMirror commands rather
   * than simulating a DOM KeyboardEvent via keyboardShortcut(). This
   * is more reliable in headless/jsdom environments where synthetic
   * keyboard events may not propagate through the full input pipeline.
   *
   * The chain tries each command in order until one succeeds:
   *   1. deleteSelection — handles non-empty selections
   *   2. joinBackward — merges with the previous block
   *   3. selectNodeBackward — selects an atomic node before the cursor
   *
   * If none of these handle it (cursor mid-text, no structural operation),
   * we fall back to deleting the single character before the cursor.
   */
  private handleBackspace(command: Command): void {
    this.requireEditor(command.id, (editor) => {
      const { state, view } = editor;
      const { dispatch } = view;

      /**
       * Try the ProseMirror command chain. Each command returns true
       * if it handled the backspace, false otherwise.
       */
      const handled =
        deleteSelection(state, dispatch) ||
        joinBackward(state, dispatch) ||
        selectNodeBackward(state, dispatch);

      if (!handled) {
        /**
         * None of the structural commands applied. This means the cursor
         * is in a position where a simple character deletion is needed
         * (e.g., mid-text). Delete the character immediately before the cursor.
         */
        const { from } = editor.state.selection;
        if (from > 0) {
          editor
            .chain()
            .focus()
            .deleteRange({ from: from - 1, to: from })
            .run();
        }
      }

      this.sendResponse(command.id, true);
    });
  }

  /**
   * Simulate an Enter keypress through TipTap's keyboardShortcut command.
   * This runs ProseMirror's full Enter keybinding chain which includes:
   *   - newlineInCode (insert newline inside code blocks)
   *   - createParagraphNear (create paragraph next to non-text blocks)
   *   - liftEmptyBlock (lift out of empty blockquote/list)
   *   - splitListItem (split list items correctly)
   *   - splitBlock (default paragraph splitting)
   *
   * This gives the port correct context-sensitive enter behavior without
   * needing to understand which block type the cursor is in.
   */
  private handleEnter(command: Command): void {
    this.requireEditor(command.id, (editor) => {
      editor.commands.keyboardShortcut("Enter");
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
   * Called on every ProseMirror transaction.
   *
   * While a command is in flight (currentCommandId set), this does NOT emit.
   * It only marks state dirty; the command flush (flushPendingState) builds
   * and emits once after the handler completes, coalescing the command's
   * multiple transactions (content insert, trailing-node append, selection
   * settle) into a single state build and a single emit.
   *
   * Outside a command (no command id — asynchronous plugin transactions,
   * external edits), there is no command boundary to coalesce against, so the
   * state is emitted immediately, exactly as the engine did before coalescing.
   */
  private onTransaction(_transaction: Transaction): void {
    if (!this.editor) {
      return;
    }

    if (this.currentCommandId !== null) {
      /**
       * In-command transaction: defer to the post-handler flush. Marking
       * dirty (rather than emitting) is what collapses N transactions per
       * command into one emit.
       */
      this.stateDirty = true;
      return;
    }

    /**
     * Out-of-command transaction: emit immediately with no causedBy and no
     * command timer, preserving delivery of engine-caused state changes that
     * happen outside the command path.
     */
    this.emitState(this.editor, null, null);
  }

  /**
   * Emit the coalesced state for the command currently completing, if any
   * transaction occurred during it. Called once at the end of handleCommand,
   * after the handler's synchronous work (and all transactions it dispatched)
   * has finished, with the command context (id, timer) still intact.
   *
   * No-op when no transaction occurred (queries, commands that did not mutate
   * state), so those commands emit no stateChanged — matching the prior
   * behavior where a command that produced no transaction produced no event.
   */
  private flushPendingState(): void {
    if (!this.editor || !this.stateDirty) {
      return;
    }
    this.stateDirty = false;
    this.emitState(this.editor, this.currentCommandId, this.currentTimer);
  }

  /**
   * Build the state payload once and emit the appropriate events: always a
   * stateChanged, plus either contentChanged (if the document changed since
   * the last emit) or selectionChanged (if not). Optionally stamps causedBy
   * and records build timings when a command timer is supplied.
   *
   * This is the single emission path for both the coalesced in-command flush
   * and the immediate out-of-command case. Centralizing it means the
   * content-vs-selection decision, the docDiff bookkeeping, and the event
   * shapes live in exactly one place regardless of which path triggered the
   * emit.
   */
  private emitState(
    editor: Editor,
    causedBy: string | null,
    timer: PhaseTimer | null
  ): void {
    /**
     * Record total emit time when a command timer is present. The span wraps
     * the build + diff below; buildStatePayload records its own sub-phases
     * inside it.
     */
    if (timer) {
      timer.start(Phase.total);
    }

    const statePayload = this.buildStatePayload(editor, timer);

    /**
     * Detect whether the document content changed by comparing the serialized
     * document JSON against the last emitted doc. Timed as the docDiff phase.
     * Because emission is now coalesced per command, this compares the FINAL
     * settled document for the keystroke against the previous emit — so a
     * keystroke whose follow-on transactions net a document change (e.g. a
     * trailing-node append) is correctly classified as a content change, and
     * one that only moved the selection is classified as selection-only.
     */
    const currentDocJson = timer
      ? timer.measure(Phase.docDiff, () => JSON.stringify(statePayload.doc))
      : JSON.stringify(statePayload.doc);
    const docChanged = currentDocJson !== this.lastDocJson;

    if (timer) {
      timer.stop(Phase.total);
    }

    const stateChangedEvent: StateChangedEvent = {
      type: "event",
      name: "stateChanged",
      payload: statePayload,
      ...(causedBy ? { causedBy } : {}),
      ...this.timingsField(timer),
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
   *
   * When a timer is supplied, the three expensive build steps are recorded
   * as separate phases: serializeDoc (the recursive tree walk), commandStates
   * (the canExec + isActive sweep), and active (the combined
   * active-marks/nodes/stored-marks extraction). The commandStates call is
   * additionally passed the timer so it can split its own cost into the
   * commandStatesCan and commandStatesActive sub-phases. When no timer is
   * supplied (getState, init, out-of-command emits), the steps run untimed.
   * The behavior is unchanged either way — measure() passes the result
   * through and the sweep visits the same commands.
   */
  private buildStatePayload(
    editor: Editor,
    timer?: PhaseTimer | null
  ): StateChangedEvent["payload"] {
    if (timer) {
      const doc = timer.measure(Phase.serializeDoc, () =>
        serializeDocument(editor.state)
      );
      const selection = serializeSelection(editor.state);
      const commandStates = timer.measure(Phase.commandStates, () =>
        computeCommandStates(editor, timer)
      );
      const { activeMarks, activeNodes, storedMarks } = timer.measure(
        Phase.active,
        () => ({
          activeMarks: getActiveMarks(editor.state),
          activeNodes: getActiveNodes(editor.state),
          storedMarks: getStoredMarks(editor.state),
        })
      );

      return {
        doc,
        selection,
        activeMarks,
        activeNodes,
        commandStates,
        decorations: getDecorations(editor.state),
        storedMarks,
        editable: editor.isEditable,
      };
    }

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
   *
   * Closes the handle phase on the current command's timer (the span opened
   * in handleCommand) and attaches the accumulated timings to the response.
   * The handle phase therefore measures from dispatch entry to this point —
   * the command's execution work. The coalesced state build/emit runs after
   * this (in flushPendingState) and is attributed to the same timer via its
   * own sub-phases, which ride out on the subsequent stateChanged.
   */
  private sendResponse(
    id: string,
    success: boolean,
    payload?: unknown,
    error?: { code: string; message: string }
  ): void {
    const timer = this.currentTimer;
    if (timer) {
      timer.stop(Phase.handle);
    }

    const response: Response = {
      type: "response",
      id,
      success,
      payload,
      error,
      ...this.timingsField(timer),
    };
    this.adapter.send(response);
  }

  /**
   * Build the optional timings field spread for a message. Returns an object
   * with a timings key only when the timer exists and recorded at least one
   * phase, so an empty timer adds nothing to the message (the field is absent
   * on the wire rather than present-and-empty). Spreading the result keeps the
   * call sites clean: `...this.timingsField(timer)`.
   *
   * Note: because the handle phase is the only phase recorded by the time
   * sendResponse runs (the build sub-phases are recorded later, in the flush),
   * the Response carries handle while the subsequent stateChanged carries the
   * build breakdown. Both read from the same timer instance, so the two
   * messages together describe the whole command.
   */
  private timingsField(timer: PhaseTimer | null | undefined): {
    timings?: Timings;
  } {
    if (timer && timer.hasTimings()) {
      return { timings: timer.toTimings() };
    }
    return {};
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
