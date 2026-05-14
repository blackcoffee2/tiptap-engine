// ============================================================================
// Protocol Types
//
// All communication between the engine and port is JSON-serializable and
// message-based. The engine receives Commands, returns Responses (correlated
// by id), and pushes Events asynchronously.
//
// Port implementations (Flutter, Swift, Kotlin, etc.) generate their own
// typed models from these definitions.
// ============================================================================

// ----------------------------------------------------------------------------
// Annotated Document Types
//
// The engine annotates every node in the document JSON with ProseMirror
// position offsets (pos/end). This allows ports to map pixel coordinates
// back to document positions without understanding ProseMirror's internal
// position addressing.
// ----------------------------------------------------------------------------

/**
 * A mark applied to a text node. Marks represent inline formatting
 * (bold, italic, link, etc.) and carry optional attributes.
 */
export interface AnnotatedMark {
  type: string;
  attrs?: Record<string, unknown>;
}

/**
 * A single node in the annotated document tree. Every node carries its
 * ProseMirror position range (pos/end) so the port can map tap coordinates
 * to document positions by adding a local character offset to the node's pos.
 */
export interface AnnotatedNode {
  type: string;

  /**
   * ProseMirror document position where this node's content starts.
   * For block nodes, this is the position after the opening token.
   * For text nodes, this is the position of the first character.
   */
  pos: number;

  /**
   * ProseMirror document position where this node ends (exclusive).
   * Equals pos + nodeSize for the node.
   */
  end: number;

  /** Node attributes (heading level, image src, link href, etc.) */
  attrs?: Record<string, unknown>;

  /** Child nodes. Absent for leaf nodes (text, image, horizontalRule). */
  content?: AnnotatedNode[];

  /** Marks applied to this node. Only present on text nodes. */
  marks?: AnnotatedMark[];

  /** Text content. Only present on text nodes. */
  text?: string;
}

// ----------------------------------------------------------------------------
// Selection Types
// ----------------------------------------------------------------------------

export type SelectionType = "text" | "node" | "all" | "gapcursor";

export interface SelectionState {
  /** Discriminant for the selection kind */
  type: SelectionType;

  /**
   * The anchor is the side of the selection that doesn't move when
   * the user extends the selection. For a cursor, anchor === head.
   */
  anchor: number;

  /**
   * The head is the moving side of the selection. For a cursor, head === anchor.
   */
  head: number;

  /** Start of the selection range (min of anchor, head) */
  from: number;

  /** End of the selection range (max of anchor, head) */
  to: number;

  /** True when the selection is a cursor (from === to) */
  empty: boolean;
}

// ----------------------------------------------------------------------------
// Command State Types
//
// Command states drive the toolbar UI. Each entry tells the port whether
// a command can execute, whether it's currently active (e.g., bold is on),
// and for undo/redo the stack depth.
// ----------------------------------------------------------------------------

export interface CommandState {
  /** Whether the command can be executed in the current state */
  canExec: boolean;

  /** Whether the mark/node this command controls is active at the selection */
  isActive: boolean;

  /**
   * Stack depth for undo/redo commands. Allows the port to show a badge
   * count on the undo/redo buttons. Undefined for non-history commands.
   */
  depth?: number;
}

// ----------------------------------------------------------------------------
// Decoration Types
//
// Decorations are visual annotations that don't affect the document model.
// Used for search highlights, collaboration cursors, placeholders, etc.
// ----------------------------------------------------------------------------

export type DecorationType = "inline" | "widget" | "node";

export interface DecorationInfo {
  type: DecorationType;

  /** Start position of the decoration in the document */
  from: number;

  /** End position of the decoration in the document */
  to: number;

  /** Decoration-specific attributes (CSS classes, styles, widget data, etc.) */
  attrs?: Record<string, unknown>;
}

// ----------------------------------------------------------------------------
// Schema Introspection Types
//
// Emitted once via the schemaReady event. Ports use this metadata to
// auto-generate toolbars and understand the document structure without
// hardcoding extension knowledge.
// ----------------------------------------------------------------------------

export interface NodeAttrInfo {
  name: string;
  default: unknown;
}

export interface NodeTypeInfo {
  /** The node type name (e.g., "paragraph", "heading", "image") */
  name: string;

  /**
   * ProseMirror content expression defining what children this node accepts.
   * E.g., "inline*" for paragraph, "block+" for doc.
   */
  contentExpression: string;

  /** The group this node belongs to (e.g., "block", "inline") */
  group: string | null;

  /** Attributes defined on this node type with their defaults */
  attrs: NodeAttrInfo[];

  /** Whether this node is a leaf (no content allowed) */
  isLeaf: boolean;

  /** Whether this node is an inline node */
  isInline: boolean;

  /** Whether this node is a block node */
  isBlock: boolean;
}

export interface MarkAttrInfo {
  name: string;
  default: unknown;
}

export interface MarkTypeInfo {
  /** The mark type name (e.g., "bold", "italic", "link") */
  name: string;

  /** Attributes defined on this mark type with their defaults */
  attrs: MarkAttrInfo[];
}

/**
 * The type of a command, describing its behavior pattern.
 * Ports use this to determine how to present the command in the UI
 * (toggle button vs dropdown vs action button).
 */
export type CommandType =
  | "toggle-mark" // Toggles an inline mark (bold, italic, etc.)
  | "toggle-node" // Toggles a block node type (heading, code block)
  | "set-node" // Sets a block node type without toggle behavior
  | "wrap" // Wraps selection in a node (blockquote, list)
  | "lift" // Lifts content out of a wrapping node
  | "action"; // One-shot action (undo, redo, insertTable, etc.)

export interface CommandArgInfo {
  name: string;
  description?: string;
  required: boolean;
}

export interface CommandInfo {
  /** The command name as used in exec calls */
  name: string;

  /** The behavioral type of this command */
  type: CommandType;

  /**
   * The mark or node type this command is associated with, if any.
   * E.g., "toggleBold" is associated with the "bold" mark.
   */
  associatedType?: string;

  /** Arguments this command accepts */
  args: CommandArgInfo[];

  /**
   * UI grouping hint. Ports can use this to cluster related commands
   * in the toolbar. E.g., "formatting", "lists", "history", "insert".
   */
  group?: string;

  /** Which extension provides this command */
  extensionName: string;
}

export interface SchemaMetadata {
  nodes: NodeTypeInfo[];
  marks: MarkTypeInfo[];
  commands: CommandInfo[];
}

// ----------------------------------------------------------------------------
// Active Node/Mark Types
//
// Included in state updates so the port knows what's active at the
// current selection without making round-trip queries.
// ----------------------------------------------------------------------------

export interface ActiveNode {
  type: string;
  attrs: Record<string, unknown>;
}

// ----------------------------------------------------------------------------
// Commands (Port → Engine)
//
// Commands are requests from the native side to mutate or query the
// editor state. Every command carries a unique id for response correlation.
// ----------------------------------------------------------------------------

/**
 * Configuration for an individual extension during initialization.
 * The name maps to the extension registry. Options are passed through
 * to the Tiptap extension's configure() method.
 */
export interface ExtensionConfig {
  name: string;
  options?: Record<string, unknown>;
}

/**
 * Base interface for all commands. The id field is used to correlate
 * commands with their responses.
 */
interface BaseCommand {
  type: "command";
  id: string;
  name: string;
  payload: Record<string, unknown>;
}

// --- Lifecycle Commands ---

export interface InitCommand extends BaseCommand {
  name: "init";
  payload: {
    /**
     * Extensions to enable. If omitted, StarterKit defaults are used.
     * Each entry specifies an extension name and optional configuration.
     */
    extensions?: ExtensionConfig[];

    /**
     * Initial document content. Can be a Tiptap JSON document object
     * or an HTML string. If omitted, the editor starts empty.
     */
    content?: Record<string, unknown> | string;

    /** Whether the editor starts in editable mode. Defaults to true. */
    editable?: boolean;
  };
}

export interface DestroyCommand extends BaseCommand {
  name: "destroy";
  payload: Record<string, never>;
}

export interface SetEditableCommand extends BaseCommand {
  name: "setEditable";
  payload: {
    editable: boolean;
  };
}

// --- Content Commands ---

export interface SetContentCommand extends BaseCommand {
  name: "setContent";
  payload: {
    /** Document content as Tiptap JSON or HTML string */
    content: Record<string, unknown> | string;

    /**
     * Whether to emit a stateChanged event after setting content.
     * Defaults to true.
     */
    emitUpdate?: boolean;
  };
}

export type ContentFormat = "json" | "html" | "text";

export interface GetContentCommand extends BaseCommand {
  name: "getContent";
  payload: {
    /** The format to return the content in */
    format: ContentFormat;
  };
}

export interface InsertContentAtCommand extends BaseCommand {
  name: "insertContentAt";
  payload: {
    /** Position or range to insert at */
    position: number | { from: number; to: number };

    /** Content to insert (JSON node, HTML string, or text) */
    content: Record<string, unknown> | string;
  };
}

// --- Text Input Commands ---

export interface InsertTextCommand extends BaseCommand {
  name: "insertText";
  payload: {
    /** The text to insert */
    text: string;

    /**
     * Optional range to replace. If omitted, inserts at the current selection.
     * Used when the port knows the exact range to replace (e.g., after
     * composition commit with a known composing range).
     */
    range?: { from: number; to: number };
  };
}

export interface DeleteRangeCommand extends BaseCommand {
  name: "deleteRange";
  payload: {
    /**
     * The range to delete. If omitted, performs a backspace-style
     * deletion at the current cursor position.
     */
    range?: { from: number; to: number };
  };
}

// --- Generic Command Execution ---

export interface ExecCommand extends BaseCommand {
  name: "exec";
  payload: {
    /** The Tiptap command name (e.g., "toggleBold", "setHeading") */
    command: string;

    /**
     * Arguments to pass to the command. Varies by command.
     * E.g., { level: 2 } for setHeading, {} for toggleBold.
     */
    args?: Record<string, unknown>;
  };
}

// --- Selection Commands ---

export interface SetTextSelectionCommand extends BaseCommand {
  name: "setTextSelection";
  payload: {
    /** Anchor position (fixed side of selection) */
    anchor: number;

    /** Head position (moving side). If omitted, equals anchor (cursor). */
    head?: number;
  };
}

export interface SetNodeSelectionCommand extends BaseCommand {
  name: "setNodeSelection";
  payload: {
    /** Position of the node to select */
    position: number;
  };
}

export interface SelectAllCommand extends BaseCommand {
  name: "selectAll";
  payload: Record<string, never>;
}

export interface FocusCommand extends BaseCommand {
  name: "focus";
  payload: {
    /**
     * Where to place the cursor on focus. Defaults to the current position.
     * "start" = beginning of doc, "end" = end of doc, "all" = select all,
     * number = specific position.
     */
    position?: "start" | "end" | "all" | number;
  };
}

export interface BlurCommand extends BaseCommand {
  name: "blur";
  payload: Record<string, never>;
}

// --- Query Commands ---

export interface GetStateCommand extends BaseCommand {
  name: "getState";
  payload: Record<string, never>;
}

export interface IsActiveCommand extends BaseCommand {
  name: "isActive";
  payload: {
    /** Name of the mark or node type to check */
    name: string;

    /** Optional attributes to match */
    attrs?: Record<string, unknown>;
  };
}

export interface CanExecCommand extends BaseCommand {
  name: "canExec";
  payload: {
    /** The command name to check */
    command: string;

    /** Optional arguments for the check */
    args?: Record<string, unknown>;
  };
}

export interface GetAttributesCommand extends BaseCommand {
  name: "getAttributes";
  payload: {
    /** Name of the mark or node type to get attributes for */
    name: string;
  };
}

/**
 * Discriminated union of all command types. The name field acts as the
 * discriminant for narrowing.
 */
export type Command =
  | InitCommand
  | DestroyCommand
  | SetEditableCommand
  | SetContentCommand
  | GetContentCommand
  | InsertContentAtCommand
  | InsertTextCommand
  | DeleteRangeCommand
  | ExecCommand
  | SetTextSelectionCommand
  | SetNodeSelectionCommand
  | SelectAllCommand
  | FocusCommand
  | BlurCommand
  | GetStateCommand
  | IsActiveCommand
  | CanExecCommand
  | GetAttributesCommand;

// ----------------------------------------------------------------------------
// Events (Engine → Port)
//
// Events are pushed asynchronously whenever state changes or lifecycle
// milestones are reached. Ports subscribe to events to update their UI.
// ----------------------------------------------------------------------------

interface BaseEvent {
  type: "event";
  name: string;
}

/**
 * Emitted once after init, before ready. Contains full schema introspection
 * so ports can auto-generate toolbars and understand the document structure.
 */
export interface SchemaReadyEvent extends BaseEvent {
  name: "schemaReady";
  payload: SchemaMetadata;
}

/**
 * Emitted once after init, after schemaReady. Signals the engine is fully
 * initialized and ready to accept commands.
 */
export interface ReadyEvent extends BaseEvent {
  name: "ready";
  payload: Record<string, never>;
}

/**
 * Emitted after every transaction. The primary event ports use to re-render.
 * Contains the complete editor state needed for a full UI update.
 */
export interface StateChangedEvent extends BaseEvent {
  name: "stateChanged";
  payload: {
    /** Full annotated document tree with pos/end on every node */
    doc: AnnotatedNode;

    /** Current selection state */
    selection: SelectionState;

    /** Names of marks active at the current selection */
    activeMarks: string[];

    /** Node types active at the current selection with their attributes */
    activeNodes: ActiveNode[];

    /**
     * Map of command name → current state. Drives toolbar button
     * enabled/disabled and active/inactive states.
     */
    commandStates: Record<string, CommandState>;

    /** Active decorations (search highlights, collab cursors, etc.) */
    decorations: DecorationInfo[];

    /**
     * Marks that will be applied to the next typed text. These are
     * "pending" marks set by toggling a mark with an empty selection.
     */
    storedMarks: AnnotatedMark[];

    /** Whether the editor is currently editable */
    editable: boolean;
  };
}

/**
 * Emitted only when the document content changes (not on selection-only
 * changes). Useful for debounced auto-save without reacting to every
 * cursor movement.
 */
export interface ContentChangedEvent extends BaseEvent {
  name: "contentChanged";
  payload: {
    /** The updated annotated document tree */
    doc: AnnotatedNode;
  };
}

/**
 * Emitted on selection-only changes (no document mutation). Lighter than
 * stateChanged — omits the document tree.
 */
export interface SelectionChangedEvent extends BaseEvent {
  name: "selectionChanged";
  payload: {
    selection: SelectionState;
    activeMarks: string[];
    activeNodes: ActiveNode[];
    commandStates: Record<string, CommandState>;
  };
}

/**
 * Emitted when an error occurs in the engine. May be associated with
 * a specific command (via commandId) or be a general engine error.
 */
export interface ErrorEvent extends BaseEvent {
  name: "error";
  payload: {
    code: string;
    message: string;

    /** The command id that caused the error, if applicable */
    commandId?: string;
  };
}

/**
 * Generic passthrough for extension-specific events. The engine does not
 * interpret these — it forwards them to the port for handling.
 * E.g., a mention extension might emit suggestion queries through this.
 */
export interface ExtensionEventPayload extends BaseEvent {
  name: "extensionEvent";
  payload: {
    /** The extension that emitted this event */
    extensionName: string;

    /** The extension-defined event name */
    eventName: string;

    /** Arbitrary data from the extension */
    data: unknown;
  };
}

/**
 * Discriminated union of all event types. The name field acts as the
 * discriminant for narrowing.
 */
export type Event =
  | SchemaReadyEvent
  | ReadyEvent
  | StateChangedEvent
  | ContentChangedEvent
  | SelectionChangedEvent
  | ErrorEvent
  | ExtensionEventPayload;

// ----------------------------------------------------------------------------
// Responses
//
// Responses are correlated to commands by id. Query commands include
// their result in the payload field.
// ----------------------------------------------------------------------------

export interface ResponseError {
  code: string;
  message: string;
}

export interface Response {
  type: "response";

  /** The id of the command this response is for */
  id: string;

  /** Whether the command executed successfully */
  success: boolean;

  /** Result data for query commands (getContent, isActive, etc.) */
  payload?: unknown;

  /** Error details when success is false */
  error?: ResponseError;
}

// ----------------------------------------------------------------------------
// Top-level Message Type
//
// Every message flowing through the bridge is one of these three types.
// The type field is the top-level discriminant.
// ----------------------------------------------------------------------------

export type Message = Command | Event | Response;
