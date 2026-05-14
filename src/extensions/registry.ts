// ============================================================================
// Extension Registry
//
// Maps extension name strings to their Tiptap extension constructors.
// When the init command arrives with a list of extension names and
// optional configs, this registry resolves them to configured Tiptap
// extension instances.
//
// Tiptap v3 restructured extension packages:
// - Lists consolidated into @tiptap/extension-list (BulletList, OrderedList,
//   ListItem, TaskList, TaskItem, ListKeymap, ListKit)
// - Tables consolidated into @tiptap/extension-table (Table, TableRow,
//   TableCell, TableHeader, TableKit)
// - Utility extensions consolidated into @tiptap/extensions (History,
//   Placeholder, CharacterCount, DropCursor, GapCursor, TrailingNode,
//   Focus, Selection)
// - StarterKit now includes Link, Underline, ListKeymap, and TrailingNode
//
// For v1, all extensions are pre-bundled. Custom extension loading
// at runtime is a future milestone.
// ============================================================================

import { type AnyExtension } from "@tiptap/core";

// --- Core node extensions (from @tiptap/core, re-exported by starter-kit) ---
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import Blockquote from "@tiptap/extension-blockquote";
import CodeBlock from "@tiptap/extension-code-block";
import HardBreak from "@tiptap/extension-hard-break";
import Heading from "@tiptap/extension-heading";
import HorizontalRule from "@tiptap/extension-horizontal-rule";
import Image from "@tiptap/extension-image";

// --- List extensions (consolidated in v3) ---
import {
  BulletList,
  OrderedList,
  ListItem,
  TaskList,
  TaskItem,
  ListKeymap,
} from "@tiptap/extension-list";

// --- Table extensions (consolidated in v3) ---
import {
  Table,
  TableRow,
  TableCell,
  TableHeader,
} from "@tiptap/extension-table";

// --- Mark extensions ---
import Bold from "@tiptap/extension-bold";
import Italic from "@tiptap/extension-italic";
import Strike from "@tiptap/extension-strike";
import Code from "@tiptap/extension-code";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import { Highlight } from "@tiptap/extension-highlight";
import { Superscript } from "@tiptap/extension-superscript";
import { Subscript } from "@tiptap/extension-subscript";
import { TextStyle } from "@tiptap/extension-text-style";

// --- Utility extensions (consolidated in @tiptap/extensions in v3) ---
import {
  UndoRedo,
  Dropcursor,
  Gapcursor,
  Placeholder,
  CharacterCount,
  TrailingNode,
} from "@tiptap/extensions";

// --- Standalone functional extensions ---
import TextAlign from "@tiptap/extension-text-align";
import Color from "@tiptap/extension-color";
import Typography from "@tiptap/extension-typography";

/**
 * Factory function type for creating a configured extension instance.
 * Receives optional user-provided configuration and returns a Tiptap
 * extension ready to be passed to the Editor constructor.
 */
type ExtensionFactory = (options?: Record<string, unknown>) => AnyExtension;

/**
 * Registry entry containing the factory and metadata about the extension.
 */
interface RegistryEntry {
  factory: ExtensionFactory;

  /**
   * Extensions that this extension depends on. If a user enables "table"
   * without explicitly enabling "tableRow", "tableCell", and "tableHeader",
   * the registry automatically includes the dependencies.
   */
  dependencies?: string[];
}

/**
 * The complete registry of all bundled extensions. Each key is the
 * canonical name used in the init command's extensions array.
 *
 * Extension names follow Tiptap's naming convention: camelCase,
 * matching the extension's name property.
 */
const REGISTRY: Record<string, RegistryEntry> = {
  // --- Core node types (required for a functional editor) ---
  document: {
    factory: (opts) => Document.configure(opts),
  },
  paragraph: {
    factory: (opts) => Paragraph.configure(opts),
  },
  text: {
    factory: (opts) => Text.configure(opts),
  },

  // --- Block node types ---
  blockquote: {
    factory: (opts) => Blockquote.configure(opts),
  },
  bulletList: {
    factory: (opts) => BulletList.configure(opts),
  },
  orderedList: {
    factory: (opts) => OrderedList.configure(opts),
  },
  listItem: {
    factory: (opts) => ListItem.configure(opts),
  },
  heading: {
    factory: (opts) => Heading.configure(opts),
  },
  codeBlock: {
    factory: (opts) => CodeBlock.configure(opts),
  },
  horizontalRule: {
    factory: (opts) => HorizontalRule.configure(opts),
  },
  hardBreak: {
    factory: (opts) => HardBreak.configure(opts),
  },
  image: {
    factory: (opts) => Image.configure(opts),
  },
  table: {
    factory: (opts) => Table.configure(opts),
    dependencies: ["tableRow", "tableCell", "tableHeader"],
  },
  tableRow: {
    factory: (opts) => TableRow.configure(opts),
  },
  tableCell: {
    factory: (opts) => TableCell.configure(opts),
  },
  tableHeader: {
    factory: (opts) => TableHeader.configure(opts),
  },
  taskList: {
    factory: (opts) => TaskList.configure(opts),
    dependencies: ["taskItem"],
  },
  taskItem: {
    factory: (opts) => TaskItem.configure(opts),
  },

  // --- Mark types ---
  bold: {
    factory: (opts) => Bold.configure(opts),
  },
  italic: {
    factory: (opts) => Italic.configure(opts),
  },
  strike: {
    factory: (opts) => Strike.configure(opts),
  },
  code: {
    factory: (opts) => Code.configure(opts),
  },
  underline: {
    factory: (opts) => Underline.configure(opts),
  },
  link: {
    factory: (opts) =>
      Link.configure({
        /**
         * Default link configuration for headless mode. openOnClick is
         * disabled because the engine doesn't handle navigation — the
         * port is responsible for link tap behavior.
         */
        openOnClick: false,
        ...opts,
      }),
  },
  highlight: {
    factory: (opts) => Highlight.configure(opts),
  },
  superscript: {
    factory: (opts) => Superscript.configure(opts),
  },
  subscript: {
    factory: (opts) => Subscript.configure(opts),
  },
  textStyle: {
    factory: (opts) => TextStyle.configure(opts),
  },

  // --- Functional extensions ---

  /**
   * In v3, the history extension is accessed as "undoRedo" in StarterKit
   * configuration, but the extension itself is still History from
   * @tiptap/extensions. We register it under both names for clarity.
   */
  history: {
    factory: (opts) => UndoRedo.configure(opts),
  },
  undoRedo: {
    factory: (opts) => UndoRedo.configure(opts),
  },
  dropcursor: {
    factory: (opts) => Dropcursor.configure(opts),
  },
  gapcursor: {
    factory: (opts) => Gapcursor.configure(opts),
  },
  placeholder: {
    factory: (opts) => Placeholder.configure(opts),
  },
  textAlign: {
    factory: (opts) =>
      TextAlign.configure({
        /**
         * By default, text alignment applies to paragraphs and headings.
         * Users can override this via the options in the init command.
         */
        types: ["heading", "paragraph"],
        ...opts,
      }),
  },
  color: {
    factory: (opts) => Color.configure(opts),
    /**
     * The color extension requires textStyle to function, since it
     * stores the color value as an attribute on the textStyle mark.
     */
    dependencies: ["textStyle"],
  },
  typography: {
    factory: (opts) => Typography.configure(opts),
  },
  characterCount: {
    factory: (opts) => CharacterCount.configure(opts),
  },
  /**
   * New in v3: ListKeymap improves keyboard behavior in lists
   * (backspace at start of list item, etc.). Included in StarterKit.
   */
  listKeymap: {
    factory: (opts) => ListKeymap.configure(opts),
  },
  /**
   * New in v3: TrailingNode automatically inserts an empty node at the
   * end of the document, making it easier to continue writing after
   * elements like tables or images. Included in StarterKit.
   */
  trailingNode: {
    factory: (opts) => TrailingNode.configure(opts),
  },
};

/**
 * The default set of extensions enabled when no explicit extension list
 * is provided in the init command. Matches Tiptap v3 StarterKit plus
 * the additional extensions listed in the design document.
 *
 * StarterKit v3 includes:
 *   Blockquote, BulletList, CodeBlock, Document, HardBreak, Heading,
 *   HorizontalRule, ListItem, OrderedList, Paragraph, Text, Bold, Code,
 *   Italic, Link, Strike, Underline, Dropcursor, Gapcursor, Undo/Redo,
 *   ListKeymap, TrailingNode
 *
 * Additional extensions from design doc:
 *   TextAlign, Image, Placeholder, Color, TextStyle, Table (+ row/cell/header),
 *   Superscript, Subscript, Highlight, TaskList, TaskItem, Typography,
 *   CharacterCount
 */
const DEFAULT_EXTENSIONS: string[] = [
  // Core (required)
  "document",
  "paragraph",
  "text",

  // StarterKit block nodes
  "blockquote",
  "bulletList",
  "orderedList",
  "listItem",
  "heading",
  "codeBlock",
  "horizontalRule",
  "hardBreak",

  // StarterKit marks
  "bold",
  "italic",
  "strike",
  "code",
  "underline",
  "link",

  // StarterKit functional
  "history",
  "dropcursor",
  "gapcursor",
  "listKeymap",
  "trailingNode",

  // Additional extensions from design doc
  "textAlign",
  "image",
  "placeholder",
  "color",
  "textStyle",
  "table",
  "tableRow",
  "tableCell",
  "tableHeader",
  "superscript",
  "subscript",
  "highlight",
  "taskList",
  "taskItem",
  "typography",
  "characterCount",
];

export interface ExtensionRequest {
  name: string;
  options?: Record<string, unknown>;
}

/**
 * Resolve an array of extension requests into configured Tiptap extension
 * instances. Handles dependency resolution (e.g., table → tableRow) and
 * deduplication.
 *
 * @param requests - Extension names with optional configuration. If null
 *   or empty, the default extension set is used.
 * @returns Array of configured Tiptap extension instances.
 * @throws Error if a requested extension name is not found in the registry.
 */
export function resolveExtensions(
  requests?: ExtensionRequest[] | null
): AnyExtension[] {
  /**
   * Build a map of name → options from the requests. If no requests
   * are provided, use the default set with no custom options.
   */
  const requestMap = new Map<string, Record<string, unknown> | undefined>();

  if (!requests || requests.length === 0) {
    for (const name of DEFAULT_EXTENSIONS) {
      requestMap.set(name, undefined);
    }
  } else {
    for (const req of requests) {
      requestMap.set(req.name, req.options);
    }
  }

  /**
   * Resolve dependencies. Walk through all requested extensions and
   * add any missing dependencies. Dependencies are added with no
   * custom options (they use their defaults).
   */
  const resolved = new Map(requestMap);
  const queue = Array.from(requestMap.keys());

  while (queue.length > 0) {
    const name = queue.pop()!;
    const entry = REGISTRY[name];
    if (!entry) {
      continue;
    }

    if (entry.dependencies) {
      for (const dep of entry.dependencies) {
        if (!resolved.has(dep)) {
          resolved.set(dep, undefined);
          queue.push(dep);
        }
      }
    }
  }

  /**
   * Deduplicate entries that map to the same underlying extension.
   * "history" and "undoRedo" both resolve to History — if both are
   * present, keep only one (prefer "history" as the canonical name).
   */
  if (resolved.has("history") && resolved.has("undoRedo")) {
    resolved.delete("undoRedo");
  }

  /**
   * Create configured extension instances from the resolved set.
   * Throws if any requested extension is not in the registry.
   */
  const extensions: AnyExtension[] = [];

  for (const [name, options] of resolved) {
    const entry = REGISTRY[name];
    if (!entry) {
      throw new Error(
        `[TiptapEngine] Unknown extension: "${name}". ` +
          `Available extensions: ${Object.keys(REGISTRY).join(", ")}`
      );
    }
    extensions.push(entry.factory(options));
  }

  return extensions;
}

/**
 * Returns the list of all registered extension names. Used by the
 * schema inspector to provide the full list of available extensions.
 */
export function getAvailableExtensionNames(): string[] {
  return Object.keys(REGISTRY);
}
