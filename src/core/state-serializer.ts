// ============================================================================
// State Serializer
//
// Converts a ProseMirror EditorState into the annotated JSON format
// defined in the protocol. The key responsibility is annotating every
// node with its ProseMirror position offsets (pos/end) so that the
// port can map pixel coordinates back to document positions.
//
// Position model:
// ProseMirror assigns positions as a flat index into the document.
// Block nodes have an opening token (pos) and a closing token.
// - For a block node at position P with nodeSize S:
//   - pos = P (position before the opening token)
//   - Content starts at P + 1
//   - Content ends at P + S - 1
//   - end = P + S (position after the closing token)
// - For text nodes, pos is the position of the first character and
//   nodeSize equals the text length.
// - For leaf block nodes (like horizontalRule), nodeSize is 1.
//
// We annotate pos/end on every node so the port can compute document
// positions from local character offsets: docPos = node.pos + localOffset.
// ============================================================================

import type { Node as ProseMirrorNode, Mark } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import type {
  AnnotatedNode,
  AnnotatedMark,
  SelectionState,
  SelectionType,
  CommandState,
  DecorationInfo,
  ActiveNode,
} from "../types/protocol";
import { NodeSelection, AllSelection } from "@tiptap/pm/state";

/**
 * Serialize a ProseMirror mark to the protocol's AnnotatedMark format.
 */
function serializeMark(mark: Mark): AnnotatedMark {
  const result: AnnotatedMark = { type: mark.type.name };

  /**
   * Only include attrs if the mark has non-default attribute values.
   * This keeps the serialized output compact for common cases like
   * bold/italic that have no attributes.
   */
  const attrs = mark.type.spec.attrs;
  if (attrs && Object.keys(mark.attrs).length > 0) {
    const nonDefaults: Record<string, unknown> = {};
    let hasNonDefault = false;

    for (const [key, value] of Object.entries(mark.attrs)) {
      const defaultValue = attrs[key]?.default;
      if (value !== defaultValue) {
        nonDefaults[key] = value;
        hasNonDefault = true;
      }
    }

    if (hasNonDefault) {
      result.attrs = nonDefaults;
    }
  }

  return result;
}

/**
 * Recursively serialize a ProseMirror node into an AnnotatedNode with
 * position offsets.
 *
 * @param node - The ProseMirror node to serialize.
 * @param pos - The document position of this node (position before the
 *   node's opening token for block nodes, or the start of text for text nodes).
 * @returns The annotated node with pos/end offsets on every node in the tree.
 */
function serializeNode(node: ProseMirrorNode, pos: number): AnnotatedNode {
  const result: AnnotatedNode = {
    type: node.type.name,
    pos: pos,
    end: pos + node.nodeSize,
  };

  /**
   * Include attributes if the node type defines any and the node
   * has non-default values.
   */
  const specAttrs = node.type.spec.attrs;
  if (specAttrs && Object.keys(node.attrs).length > 0) {
    const nonDefaults: Record<string, unknown> = {};
    let hasNonDefault = false;

    for (const [key, value] of Object.entries(node.attrs)) {
      const defaultValue = specAttrs[key]?.default;
      if (value !== defaultValue) {
        nonDefaults[key] = value;
        hasNonDefault = true;
      }
    }

    if (hasNonDefault) {
      result.attrs = nonDefaults;
    }
  }

  /**
   * Text nodes carry their text content and marks.
   * They have no children.
   */
  if (node.isText) {
    result.text = node.text!;

    if (node.marks.length > 0) {
      result.marks = node.marks.map(serializeMark);
    }

    return result;
  }

  /**
   * For nodes with content, recursively serialize children.
   * The first child's position starts at pos + 1 (after the opening token).
   * Each subsequent child starts immediately after the previous child's end.
   */
  if (node.content.size > 0) {
    const children: AnnotatedNode[] = [];
    let childPos = pos + 1;

    node.content.forEach((child) => {
      children.push(serializeNode(child, childPos));
      childPos += child.nodeSize;
    });

    result.content = children;
  }

  return result;
}

/**
 * Serialize the full document from an EditorState into an AnnotatedNode tree.
 * The document node starts at position 0.
 */
export function serializeDocument(state: EditorState): AnnotatedNode {
  return serializeNode(state.doc, 0);
}

/**
 * Extract the current selection state from an EditorState.
 */
export function serializeSelection(state: EditorState): SelectionState {
  const { selection } = state;

  let selectionType: SelectionType = "text";
  if (selection instanceof NodeSelection) {
    selectionType = "node";
  } else if (selection instanceof AllSelection) {
    selectionType = "all";
  } else if (selection.toJSON().type === "gapcursor") {
    selectionType = "gapcursor";
  }

  return {
    type: selectionType,
    anchor: selection.anchor,
    head: selection.head,
    from: selection.from,
    to: selection.to,
    empty: selection.empty,
  };
}

/**
 * Determine which marks are active at the current selection.
 * Returns an array of mark type names.
 */
export function getActiveMarks(state: EditorState): string[] {
  const { from, $from, to, empty } = state.selection;
  const activeMarks: string[] = [];

  if (empty) {
    /**
     * With a cursor (empty selection), active marks come from either
     * stored marks (set by toggling a mark at cursor) or the marks
     * at the cursor position.
     */
    const marks = state.storedMarks || $from.marks();
    for (const mark of marks) {
      activeMarks.push(mark.type.name);
    }
  } else {
    /**
     * With a range selection, a mark is active if it's present across
     * the entire selection range. We check each mark type in the schema.
     */
    for (const markType of Object.values(state.schema.marks)) {
      let isActive = false;

      /**
       * Walk through the range and check if the mark is present on
       * all text nodes within the selection.
       */
      state.doc.nodesBetween(from, to, (node) => {
        if (node.isText) {
          if (markType.isInSet(node.marks)) {
            isActive = true;
          }
        }
      });

      if (isActive) {
        activeMarks.push(markType.name);
      }
    }
  }

  return activeMarks;
}

/**
 * Determine which node types are active at the current selection.
 * Returns nodes from the selection's depth chain (the path from
 * the document root to the deepest node at the cursor).
 */
export function getActiveNodes(state: EditorState): ActiveNode[] {
  const { $from } = state.selection;
  const activeNodes: ActiveNode[] = [];

  /**
   * Walk from the deepest node at the selection up to the document root.
   * Each depth level gives us one node in the ancestor chain.
   * Skip depth 0 (the doc node itself) as it's always active.
   */
  for (let depth = $from.depth; depth >= 1; depth--) {
    const node = $from.node(depth);
    activeNodes.push({
      type: node.type.name,
      attrs: { ...node.attrs },
    });
  }

  return activeNodes;
}

/**
 * Serialize stored marks (marks that will be applied to the next typed text).
 * These are set when a user toggles a mark with an empty selection.
 */
export function getStoredMarks(state: EditorState): AnnotatedMark[] {
  const stored = state.storedMarks;
  if (!stored || stored.length === 0) {
    return [];
  }
  return stored.map(serializeMark);
}

/**
 * Extract decoration information from the editor state.
 * Decorations are visual annotations that don't affect the document model
 * (search highlights, collaboration cursors, placeholder text, etc.).
 *
 * Note: Full decoration extraction requires access to the EditorView's
 * decoration set. In the headless engine, we extract decorations from
 * plugin states that expose them. This is a simplified implementation
 * that covers the common cases.
 */
export function getDecorations(_state: EditorState): DecorationInfo[] {
  /**
   * TODO: Implement decoration extraction from plugin states.
   * This requires iterating over all plugins and checking for
   * decoration-producing plugins (placeholder, collab cursors, etc.).
   * For v1, decorations are returned as an empty array.
   */
  return [];
}
