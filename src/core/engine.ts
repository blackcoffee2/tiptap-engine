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
// where at least one phase was actually timed, so it is omitted for the
// untimed initial-state emission and any internal build path. The stateChanged
// event also carries a causedBy id correlating it to the command that produced
// it, so the port's typing-latency tracker can pair a keystroke with its
// repaint exactly rather than by in-order approximation.
//
// Measurement in progress: the commandStates sweep is the dominant
// per-keystroke cost. It is split here into two sub-phases — commandStatesCan
// (the editor.can()[name]() dry-run half) and commandStatesActive (the
// editor.isActive(name) half) — to determine which half dominates before
// deciding whether deriving isActive from already-computed active marks/nodes
// is worth doing. This split is measurement only; it does not change what the
// sweep computes or returns.
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
 * discovered command, determines whether it can execute and whether
 * its associated mark/node is active at the current selection.
 *
 * When a timer is supplied, the two halves of the per-command work are
 * accumulated into separate sub-phases: commandStatesCan (the can() dry-run)
 * and commandStatesActive (the isActive() check). The two halves are bracketed
 * individually inside the loop and summed via the timer's clock()/add(), so
 * their totals reveal which half dominates the sweep. The timer does not
 * change which commands are visited or what is computed — the same can() and
 * isActive() calls run in the same order regardless.
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
     * default to false on failure. Timed as the commandStatesCan
     * sub-phase: the elapsed time of this call is folded into the
     * running can() total.
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
   * handleCommand and cleared on exit. onTransaction reads it to stamp the
   * causedBy field on the stateChanged it emits, correlating the state change
   * with the command that triggered it.
   *
   * A command handler runs synchronously, and the transactions a command
   * dispatches fire synchronously within that handler (ProseMirror applies
   * the transaction and the onTransaction callback runs before the command
   * returns). So while this field is set, any transaction observed is
   * attributable to this command. Transactions that fire outside a command
   * handler (the initial state during init, async plugin transactions, input
   * rules running off a later tick) see a null field and emit no causedBy,
   * which is the correct "not attributable to one command" signal.
   */
  private currentCommandId: string | null = null;

  /**
   * The PhaseTimer for the command currently being handled, set on entry to
   * handleCommand. onTransaction uses it to record the state-build sub-phases
   * (serializeDoc, commandStates, active, docDiff, total) into the same timer
   * whose handle phase the command handler is measuring, so a single Response
   * or stateChanged carries a coherent breakdown. Null when no command is in
   * flight (the same out-of-handler cases as currentCommandId).
   */
  private currentTimer: PhaseTimer | null = null;

  constructor(adapter: BaseAdapter) {
    this.adapter = adapter;
    this.adapter.onCommand(this.handleCommand.bind(this));
  }

  /**
   * Central command dispatcher. Routes incoming commands to the
   * appropriate handler method and sends back a response.
   *
   * Wraps the dispatch in a PhaseTimer: the handle phase spans from here to
   * the point each handler calls sendResponse. The timer and the command id
   * are stored on the instance so onTransaction — which fires synchronously
   * inside a mutating handler — can record the state-build sub-phases into
   * the same timer and stamp the resulting stateChanged with this command's
   * id. Both fields are cleared in finally so out-of-handler transactions are
   * never misattributed.
   */
  private handleCommand(command: Command): void {
    const timer = new PhaseTimer();
    this.currentCommandId = command.id;
    this.currentTimer = timer;
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
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      this.sendResponse(command.id, false, undefined, {
        code: "COMMAND_FAILED",
        message,
      });
      this.emitError("COMMAND_FAILED", message, command.id);
    } finally {
      /**
       * Clear the per-command instrumentation fields so any transaction
       * that fires after the handler returns (async plugin work, a later
       * input-rule tick) is not attributed to this command and emits no
       * causedBy or sub-phase timings.
       */
      this.currentCommandId = null;
      this.currentTimer = null;
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
     *
     * This emission is not attributed to the init command via causedBy:
     * it is the initial full-state push, not a keystroke-style state
     * change, so the port's latency pairing should ignore it. It is built
     * without the command timer for the same reason — init cold-start time
     * is tracked separately by the port's load phases, not the typing path.
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
   * Called on every ProseMirror transaction. Determines what changed and
   * emits the appropriate events (stateChanged, contentChanged, selectionChanged).
   *
   * When a command is in flight (currentTimer set), the state-build sub-phases
   * and the docDiff comparison are recorded into that command's timer, and the
   * total time inside this method is recorded as the total phase. The emitted
   * stateChanged is stamped with the command's id (causedBy) and carries the
   * accumulated timings. Transactions firing outside a command handler record
   * nothing and emit no causedBy.
   */
  private onTransaction(_transaction: Transaction): void {
    if (!this.editor) {
      return;
    }

    const editor = this.editor;
    const timer = this.currentTimer;
    const causedBy = this.currentCommandId;

    /**
     * Record total onTransaction time when a command timer is present. The
     * span wraps the entire method body below; we open it here and close it
     * just before returning. buildStatePayload, given the same timer, records
     * its own sub-phases inside this span.
     */
    if (timer) {
      timer.start(Phase.total);
    }

    const statePayload = this.buildStatePayload(editor, timer);

    /**
     * Detect whether the document content changed by comparing the
     * serialized document JSON. This is cheaper than deep comparison
     * for typical-sized documents. Timed as the docDiff phase — this is
     * the second full-document JSON.stringify per transaction (the first
     * being inside serialization), so its cost is worth isolating.
     */
    const currentDocJson = timer
      ? timer.measure(Phase.docDiff, () => JSON.stringify(statePayload.doc))
      : JSON.stringify(statePayload.doc);
    const docChanged = currentDocJson !== this.lastDocJson;

    /**
     * Always emit stateChanged with the full state. This is the primary
     * event ports use to re-render. Close the total span first so the timing
     * attached reflects the build + diff work; the send itself is part of the
     * round-trip the port already measures.
     */
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
   * (the canExec + isActive sweep over every command), and active (the
   * combined active-marks/nodes/stored-marks extraction). The commandStates
   * call is additionally passed the timer so it can split its own cost into
   * the commandStatesCan and commandStatesActive sub-phases. When no timer is
   * supplied (getState, init), the steps run untimed. The behavior of each
   * step is unchanged either way — measure() passes the result through and the
   * sweep visits the same commands.
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
   * for mutating commands it includes the synchronous onTransaction work, so
   * handle is the engine's total JavaScript-side cost for the command and the
   * sub-phases on the stateChanged break it down.
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
   * phase, so disabled or empty timers add nothing to the message (and the
   * field is absent on the wire rather than present-and-empty). Spreading the
   * result keeps the call sites clean: `...this.timingsField(timer)`.
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
