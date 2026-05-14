// ============================================================================
// Schema Inspector
//
// Extracts metadata from a ProseMirror schema to produce the schemaReady
// event payload. This enables ports to auto-generate toolbars and
// understand the document structure dynamically.
//
// The inspector walks the schema's node types and mark types, extracting
// their content expressions, groups, attributes, and structural properties.
// ============================================================================

import type { Schema, NodeType, MarkType } from "@tiptap/pm/model";
import type {
  NodeTypeInfo,
  NodeAttrInfo,
  MarkTypeInfo,
  MarkAttrInfo,
} from "../types/protocol";

/**
 * Extract attribute metadata from a ProseMirror node or mark type's spec.
 * Returns an array of attribute info objects with names and defaults.
 */
function extractNodeAttrs(nodeType: NodeType): NodeAttrInfo[] {
  const specAttrs = nodeType.spec.attrs;
  if (!specAttrs) {
    return [];
  }

  return Object.entries(specAttrs).map(([name, spec]) => ({
    name,
    default: (spec as { default?: unknown }).default ?? null,
  }));
}

/**
 * Extract attribute metadata from a ProseMirror mark type's spec.
 */
function extractMarkAttrs(markType: MarkType): MarkAttrInfo[] {
  const specAttrs = markType.spec.attrs;
  if (!specAttrs) {
    return [];
  }

  return Object.entries(specAttrs).map(([name, spec]) => ({
    name,
    default: (spec as { default?: unknown }).default ?? null,
  }));
}

/**
 * Inspect all node types in the schema and produce metadata objects
 * for each one.
 */
export function inspectNodeTypes(schema: Schema): NodeTypeInfo[] {
  const nodeTypes: NodeTypeInfo[] = [];

  for (const [name, nodeType] of Object.entries(schema.nodes)) {
    const spec = nodeType.spec;

    nodeTypes.push({
      name,
      contentExpression: spec.content || "",
      group: spec.group || null,
      attrs: extractNodeAttrs(nodeType),
      isLeaf: nodeType.isLeaf,
      isInline: nodeType.isInline,
      isBlock: nodeType.isBlock,
    });
  }

  return nodeTypes;
}

/**
 * Inspect all mark types in the schema and produce metadata objects
 * for each one.
 */
export function inspectMarkTypes(schema: Schema): MarkTypeInfo[] {
  const markTypes: MarkTypeInfo[] = [];

  for (const [name, markType] of Object.entries(schema.marks)) {
    markTypes.push({
      name,
      attrs: extractMarkAttrs(markType),
    });
  }

  return markTypes;
}
