// ============================================================================
// Extension Set
//
// Builds the fixed set of Tiptap extensions this engine runs with.
//
// Scope: the engine bundles Tiptap v3 StarterKit plus the Image node, and
// nothing else. There is no per-extension selection or configuration from
// the port side — every editor instance loads the same set with default
// options. Adding or changing extensions is a build-time change to this
// file, not a runtime decision.
//
// StarterKit v3 includes:
//   Blockquote, BulletList, CodeBlock, Document, HardBreak, Heading,
//   HorizontalRule, ListItem, OrderedList, Paragraph, Text, Bold, Code,
//   Italic, Link, Strike, Underline, Dropcursor, Gapcursor, Undo/Redo,
//   ListKeymap, TrailingNode
//
// Addition beyond StarterKit:
//   Image
// ============================================================================

import { type AnyExtension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";

/**
 * Build the fixed extension set for an editor instance: Tiptap v3 StarterKit
 * plus the Image node, all with default configuration.
 *
 * @returns The array of configured Tiptap extension instances.
 */
export function buildExtensions(): AnyExtension[] {
  return [
    StarterKit,

    /**
     * Image is not part of StarterKit. openOnClick has no meaning for image,
     * but like Link in headless mode, the engine doesn't handle any
     * navigation or interaction — the port owns tap behavior. Image is
     * loaded with defaults; the port supplies src/alt/title via the
     * setImage command.
     */
    Image,
  ];
}
