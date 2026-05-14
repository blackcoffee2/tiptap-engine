// ============================================================================
// Protocol Tests
//
// Verifies that the protocol types serialize and deserialize correctly,
// and that the message format matches the specification.
// ============================================================================

import { describe, it, expect } from "vitest";
import type {
  Command,
  Event,
  Response,
  InitCommand,
  ExecCommand,
  StateChangedEvent,
  SchemaReadyEvent,
  AnnotatedNode,
} from "../src/types/protocol";

describe("Protocol Types", () => {
  describe("Command serialization", () => {
    it("should serialize an init command with extensions", () => {
      const command: InitCommand = {
        type: "command",
        id: "cmd_001",
        name: "init",
        payload: {
          extensions: [
            { name: "bold" },
            { name: "heading", options: { levels: [1, 2, 3] } },
          ],
          content: "<p>Hello</p>",
          editable: true,
        },
      };

      const json = JSON.stringify(command);
      const parsed = JSON.parse(json) as InitCommand;

      expect(parsed.type).toBe("command");
      expect(parsed.id).toBe("cmd_001");
      expect(parsed.name).toBe("init");
      expect(parsed.payload.extensions).toHaveLength(2);
      expect(parsed.payload.extensions![1].options).toEqual({
        levels: [1, 2, 3],
      });
      expect(parsed.payload.content).toBe("<p>Hello</p>");
    });

    it("should serialize an exec command", () => {
      const command: ExecCommand = {
        type: "command",
        id: "cmd_002",
        name: "exec",
        payload: {
          command: "toggleBold",
          args: {},
        },
      };

      const json = JSON.stringify(command);
      const parsed = JSON.parse(json) as ExecCommand;

      expect(parsed.name).toBe("exec");
      expect(parsed.payload.command).toBe("toggleBold");
    });

    it("should serialize a command with no payload fields", () => {
      const command: Command = {
        type: "command",
        id: "cmd_003",
        name: "destroy",
        payload: {},
      };

      const json = JSON.stringify(command);
      const parsed = JSON.parse(json);

      expect(parsed.name).toBe("destroy");
      expect(parsed.payload).toEqual({});
    });
  });

  describe("Event serialization", () => {
    it("should serialize a stateChanged event with annotated doc", () => {
      const doc: AnnotatedNode = {
        type: "doc",
        pos: 0,
        end: 22,
        content: [
          {
            type: "paragraph",
            pos: 1,
            end: 21,
            content: [
              {
                type: "text",
                pos: 1,
                end: 6,
                text: "Hello",
              },
              {
                type: "text",
                pos: 6,
                end: 20,
                text: " bold world!",
                marks: [{ type: "bold" }],
              },
            ],
          },
        ],
      };

      const event: StateChangedEvent = {
        type: "event",
        name: "stateChanged",
        payload: {
          doc,
          selection: {
            type: "text",
            anchor: 5,
            head: 5,
            from: 5,
            to: 5,
            empty: true,
          },
          activeMarks: [],
          activeNodes: [{ type: "paragraph", attrs: {} }],
          commandStates: {
            toggleBold: { canExec: true, isActive: false },
            undo: { canExec: false, isActive: false, depth: 0 },
          },
          decorations: [],
          storedMarks: [],
          editable: true,
        },
      };

      const json = JSON.stringify(event);
      const parsed = JSON.parse(json) as StateChangedEvent;

      expect(parsed.type).toBe("event");
      expect(parsed.name).toBe("stateChanged");
      expect(parsed.payload.doc.type).toBe("doc");
      expect(parsed.payload.doc.pos).toBe(0);
      expect(parsed.payload.doc.content).toHaveLength(1);
      expect(parsed.payload.doc.content![0].content).toHaveLength(2);
      expect(parsed.payload.doc.content![0].content![1].marks).toEqual([
        { type: "bold" },
      ]);
      expect(parsed.payload.selection.empty).toBe(true);
    });

    it("should serialize a schemaReady event", () => {
      const event: SchemaReadyEvent = {
        type: "event",
        name: "schemaReady",
        payload: {
          nodes: [
            {
              name: "paragraph",
              contentExpression: "inline*",
              group: "block",
              attrs: [],
              isLeaf: false,
              isInline: false,
              isBlock: true,
            },
          ],
          marks: [
            {
              name: "bold",
              attrs: [],
            },
          ],
          commands: [
            {
              name: "toggleBold",
              type: "toggle-mark",
              associatedType: "bold",
              args: [],
              group: "formatting",
              extensionName: "bold",
            },
          ],
        },
      };

      const json = JSON.stringify(event);
      const parsed = JSON.parse(json) as SchemaReadyEvent;

      expect(parsed.payload.nodes[0].name).toBe("paragraph");
      expect(parsed.payload.marks[0].name).toBe("bold");
      expect(parsed.payload.commands[0].type).toBe("toggle-mark");
    });
  });

  describe("Response serialization", () => {
    it("should serialize a success response", () => {
      const response: Response = {
        type: "response",
        id: "cmd_001",
        success: true,
        payload: { content: { type: "doc", content: [] } },
      };

      const json = JSON.stringify(response);
      const parsed = JSON.parse(json) as Response;

      expect(parsed.type).toBe("response");
      expect(parsed.success).toBe(true);
      expect(parsed.id).toBe("cmd_001");
    });

    it("should serialize an error response", () => {
      const response: Response = {
        type: "response",
        id: "cmd_002",
        success: false,
        error: {
          code: "NOT_INITIALIZED",
          message: "Engine is not initialized.",
        },
      };

      const json = JSON.stringify(response);
      const parsed = JSON.parse(json) as Response;

      expect(parsed.success).toBe(false);
      expect(parsed.error?.code).toBe("NOT_INITIALIZED");
    });
  });

  describe("Message discrimination", () => {
    it("should distinguish commands, events, and responses by type field", () => {
      const command = { type: "command", id: "c1", name: "init", payload: {} };
      const event = { type: "event", name: "ready", payload: {} };
      const response = { type: "response", id: "c1", success: true };

      expect(command.type).toBe("command");
      expect(event.type).toBe("event");
      expect(response.type).toBe("response");
    });
  });

  describe("Annotated node position invariants", () => {
    it("should maintain end = pos + nodeSize for text nodes", () => {
      const textNode: AnnotatedNode = {
        type: "text",
        pos: 1,
        end: 6,
        text: "Hello",
      };

      /**
       * For text nodes, nodeSize equals the text length.
       * end should equal pos + text.length.
       */
      expect(textNode.end - textNode.pos).toBe(textNode.text!.length);
    });

    it("should maintain parent end > child end for block nodes", () => {
      const paragraph: AnnotatedNode = {
        type: "paragraph",
        pos: 0,
        end: 7,
        content: [{ type: "text", pos: 1, end: 6, text: "Hello" }],
      };

      /**
       * A paragraph wraps its content with opening and closing tokens.
       * Its pos is before the opening token, and end is after the closing token.
       * The child's pos starts at parent.pos + 1.
       */
      expect(paragraph.content![0].pos).toBe(paragraph.pos + 1);
      expect(paragraph.end).toBeGreaterThan(paragraph.content![0].end);
    });
  });
});
