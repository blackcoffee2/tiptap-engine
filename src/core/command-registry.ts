// ============================================================================
// Command Registry
//
// Discovers and catalogs all available commands from the loaded Tiptap
// extensions. This powers the "commands" section of the schemaReady event
// and enables ports to auto-generate toolbars.
//
// Tiptap's command system doesn't carry rich metadata (argument types,
// UI grouping, command behavior type), so we maintain a manual metadata
// table for known commands. Commands not in the table are still discovered
// and reported as "action" type with no additional metadata.
// ============================================================================

import type { Editor } from "@tiptap/core";
import type {
  CommandInfo,
  CommandType,
  CommandArgInfo,
} from "../types/protocol";

/**
 * Manual metadata for known Tiptap commands. This table provides
 * behavioral type, associated mark/node, arguments, and UI grouping
 * that can't be introspected from the command functions themselves.
 */
interface CommandMetadata {
  type: CommandType;
  associatedType?: string;
  args: CommandArgInfo[];
  group: string;
}

const KNOWN_COMMANDS: Record<string, CommandMetadata> = {
  // --- Mark toggles ---
  toggleBold: {
    type: "toggle-mark",
    associatedType: "bold",
    args: [],
    group: "formatting",
  },
  toggleItalic: {
    type: "toggle-mark",
    associatedType: "italic",
    args: [],
    group: "formatting",
  },
  toggleStrike: {
    type: "toggle-mark",
    associatedType: "strike",
    args: [],
    group: "formatting",
  },
  toggleCode: {
    type: "toggle-mark",
    associatedType: "code",
    args: [],
    group: "formatting",
  },
  toggleUnderline: {
    type: "toggle-mark",
    associatedType: "underline",
    args: [],
    group: "formatting",
  },
  toggleHighlight: {
    type: "toggle-mark",
    associatedType: "highlight",
    args: [{ name: "color", required: false }],
    group: "formatting",
  },
  toggleSuperscript: {
    type: "toggle-mark",
    associatedType: "superscript",
    args: [],
    group: "formatting",
  },
  toggleSubscript: {
    type: "toggle-mark",
    associatedType: "subscript",
    args: [],
    group: "formatting",
  },
  setLink: {
    type: "action",
    associatedType: "link",
    args: [
      { name: "href", required: true },
      { name: "target", required: false },
    ],
    group: "formatting",
  },
  unsetLink: {
    type: "action",
    associatedType: "link",
    args: [],
    group: "formatting",
  },
  toggleLink: {
    type: "toggle-mark",
    associatedType: "link",
    args: [
      { name: "href", required: true },
      { name: "target", required: false },
    ],
    group: "formatting",
  },
  setColor: {
    type: "action",
    associatedType: "textStyle",
    args: [{ name: "color", required: true }],
    group: "formatting",
  },
  unsetColor: {
    type: "action",
    associatedType: "textStyle",
    args: [],
    group: "formatting",
  },

  // --- Node type commands ---
  toggleHeading: {
    type: "toggle-node",
    associatedType: "heading",
    args: [{ name: "level", required: true }],
    group: "blocks",
  },
  setHeading: {
    type: "set-node",
    associatedType: "heading",
    args: [{ name: "level", required: true }],
    group: "blocks",
  },
  setParagraph: {
    type: "set-node",
    associatedType: "paragraph",
    args: [],
    group: "blocks",
  },
  toggleCodeBlock: {
    type: "toggle-node",
    associatedType: "codeBlock",
    args: [{ name: "language", required: false }],
    group: "blocks",
  },
  setCodeBlock: {
    type: "set-node",
    associatedType: "codeBlock",
    args: [{ name: "language", required: false }],
    group: "blocks",
  },
  toggleBlockquote: {
    type: "wrap",
    associatedType: "blockquote",
    args: [],
    group: "blocks",
  },
  setBlockquote: {
    type: "wrap",
    associatedType: "blockquote",
    args: [],
    group: "blocks",
  },

  // --- List commands ---
  toggleBulletList: {
    type: "toggle-node",
    associatedType: "bulletList",
    args: [],
    group: "lists",
  },
  toggleOrderedList: {
    type: "toggle-node",
    associatedType: "orderedList",
    args: [],
    group: "lists",
  },
  toggleTaskList: {
    type: "toggle-node",
    associatedType: "taskList",
    args: [],
    group: "lists",
  },
  sinkListItem: {
    type: "action",
    associatedType: "listItem",
    args: [],
    group: "lists",
  },
  liftListItem: {
    type: "lift",
    associatedType: "listItem",
    args: [],
    group: "lists",
  },
  splitListItem: {
    type: "action",
    associatedType: "listItem",
    args: [],
    group: "lists",
  },

  // --- Insert commands ---
  setHorizontalRule: {
    type: "action",
    args: [],
    group: "insert",
  },
  setHardBreak: {
    type: "action",
    args: [],
    group: "insert",
  },
  setImage: {
    type: "action",
    associatedType: "image",
    args: [
      { name: "src", required: true },
      { name: "alt", required: false },
      { name: "title", required: false },
    ],
    group: "insert",
  },

  // --- Table commands ---
  insertTable: {
    type: "action",
    associatedType: "table",
    args: [
      { name: "rows", required: false },
      { name: "cols", required: false },
      { name: "withHeaderRow", required: false },
    ],
    group: "table",
  },
  deleteTable: {
    type: "action",
    associatedType: "table",
    args: [],
    group: "table",
  },
  addColumnBefore: {
    type: "action",
    associatedType: "table",
    args: [],
    group: "table",
  },
  addColumnAfter: {
    type: "action",
    associatedType: "table",
    args: [],
    group: "table",
  },
  deleteColumn: {
    type: "action",
    associatedType: "table",
    args: [],
    group: "table",
  },
  addRowBefore: {
    type: "action",
    associatedType: "table",
    args: [],
    group: "table",
  },
  addRowAfter: {
    type: "action",
    associatedType: "table",
    args: [],
    group: "table",
  },
  deleteRow: {
    type: "action",
    associatedType: "table",
    args: [],
    group: "table",
  },
  mergeCells: {
    type: "action",
    associatedType: "table",
    args: [],
    group: "table",
  },
  splitCell: {
    type: "action",
    associatedType: "table",
    args: [],
    group: "table",
  },
  toggleHeaderRow: {
    type: "action",
    associatedType: "table",
    args: [],
    group: "table",
  },
  toggleHeaderColumn: {
    type: "action",
    associatedType: "table",
    args: [],
    group: "table",
  },
  toggleHeaderCell: {
    type: "action",
    associatedType: "table",
    args: [],
    group: "table",
  },

  // --- Text alignment ---
  setTextAlign: {
    type: "action",
    args: [{ name: "alignment", required: true }],
    group: "alignment",
  },
  unsetTextAlign: {
    type: "action",
    args: [],
    group: "alignment",
  },

  // --- History ---
  undo: {
    type: "action",
    args: [],
    group: "history",
  },
  redo: {
    type: "action",
    args: [],
    group: "history",
  },

  // --- Selection / utility ---
  selectAll: {
    type: "action",
    args: [],
    group: "selection",
  },
  focus: {
    type: "action",
    args: [{ name: "position", required: false }],
    group: "selection",
  },
  blur: {
    type: "action",
    args: [],
    group: "selection",
  },
  liftEmptyBlock: {
    type: "lift",
    args: [],
    group: "blocks",
  },
};

/**
 * Discover all commands available on the Tiptap editor and produce
 * CommandInfo metadata for each one.
 *
 * Commands are discovered by enumerating the keys of editor.commands
 * (Tiptap exposes all registered commands as methods on this object).
 * For known commands, we attach rich metadata from the KNOWN_COMMANDS
 * table. Unknown commands get a generic "action" type.
 *
 * @param editor - The initialized Tiptap editor instance.
 * @returns Array of CommandInfo objects for the schemaReady event.
 */
export function discoverCommands(editor: Editor): CommandInfo[] {
  const commands: CommandInfo[] = [];

  /**
   * Tiptap's editor.commands is a Proxy that exposes all registered
   * command functions. We enumerate its keys to discover available commands.
   *
   * Note: We access the command names through the editor's extension manager,
   * which is more reliable than trying to enumerate the Proxy's keys.
   */
  const commandNames = getCommandNames(editor);

  for (const name of commandNames) {
    const known = KNOWN_COMMANDS[name];

    if (known) {
      commands.push({
        name,
        type: known.type,
        associatedType: known.associatedType,
        args: known.args,
        group: known.group,
        extensionName: findExtensionForCommand(editor, name),
      });
    } else {
      /**
       * Unknown commands are reported as generic actions. The port can
       * still call them via exec, but the toolbar won't have rich
       * metadata for auto-generation.
       */
      commands.push({
        name,
        type: "action",
        args: [],
        group: "other",
        extensionName: findExtensionForCommand(editor, name),
      });
    }
  }

  return commands;
}

/**
 * Get all command names registered by the editor's extensions.
 * We walk through the extension manager's extensions and collect
 * command names from their addCommands() methods.
 */
function getCommandNames(editor: Editor): string[] {
  const names = new Set<string>();

  /**
   * Each extension can register commands via addCommands(). The editor
   * collects all of these into a unified commands object. We extract
   * the names by checking what commands each extension contributes.
   *
   * We cast the context to `any` because addCommands has three overloaded
   * `this` types (for Extension, Node, Mark) and TypeScript cannot unify
   * them through `.call()`. The runtime context is valid regardless.
   */
  for (const extension of editor.extensionManager.extensions) {
    if (extension.config.addCommands) {
      try {
        const context = {
          name: extension.name,
          options: extension.options,
          storage: extension.storage,
          editor,
          type: getSchemaType(extension.name, editor),
          parent: () => null,
        };

        const extensionCommands = (
          extension.config.addCommands as Function
        ).call(context);
        if (extensionCommands) {
          for (const cmdName of Object.keys(extensionCommands)) {
            names.add(cmdName);
          }
        }
      } catch {
        /**
         * Some extensions may throw if their required context isn't
         * fully available. We silently skip these — the commands may
         * still be available on the editor, just not discoverable
         * through this path.
         */
      }
    }
  }

  return Array.from(names);
}

/**
 * Get the ProseMirror schema type (NodeType or MarkType) for an extension
 * by checking the schema's nodes and marks registries.
 */
function getSchemaType(extensionName: string, editor: Editor): unknown {
  return (
    editor.schema.nodes[extensionName] ||
    editor.schema.marks[extensionName] ||
    null
  );
}

/**
 * Find which extension provides a given command by walking through
 * the extension list and checking their command contributions.
 */
function findExtensionForCommand(editor: Editor, commandName: string): string {
  for (const extension of editor.extensionManager.extensions) {
    if (extension.config.addCommands) {
      try {
        const context = {
          name: extension.name,
          options: extension.options,
          storage: extension.storage,
          editor,
          type: getSchemaType(extension.name, editor),
          parent: () => null,
        };

        const extensionCommands = (
          extension.config.addCommands as Function
        ).call(context);
        if (extensionCommands && commandName in extensionCommands) {
          return extension.name;
        }
      } catch {
        /* Skip extensions that fail to enumerate commands */
      }
    }
  }

  return "unknown";
}
