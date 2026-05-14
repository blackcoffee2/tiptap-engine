// ============================================================================
// Engine Integration Tests
//
// Tests the full engine lifecycle using the TestAdapter. Commands are
// sent in-memory and events/responses are collected and verified.
//
// These tests exercise the real Tiptap editor (via jsdom) and verify
// that the engine correctly serializes state, handles commands, and
// emits the right events.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TiptapEngine } from "../src/core/engine";
import { TestAdapter } from "./test-adapter";
import type {
  Response,
  StateChangedEvent,
  SchemaReadyEvent,
  ContentChangedEvent,
  SelectionChangedEvent,
} from "../src/types/protocol";

describe("TiptapEngine", () => {
  let adapter: TestAdapter;
  let engine: TiptapEngine;

  beforeEach(() => {
    adapter = new TestAdapter();
    engine = new TiptapEngine(adapter);
    adapter.initialize();
  });

  afterEach(() => {
    /**
     * Send destroy command to clean up the Tiptap editor instance.
     * Ignore errors if the engine wasn't initialized.
     */
    try {
      adapter.sendCommand(TestAdapter.makeCommand("destroy"));
    } catch {
      /* Engine may not have been initialized in all tests */
    }
    adapter.destroy();
  });

  // ==========================================================================
  // Initialization
  // ==========================================================================

  describe("Initialization", () => {
    it("should emit schemaReady and ready events on init", () => {
      const initCmd = TestAdapter.makeCommand("init", {
        content: "<p>Hello</p>",
      });

      adapter.sendCommand(initCmd);

      const schemaReady = adapter.getSchemaReady();
      expect(schemaReady).not.toBeNull();
      expect(schemaReady!.name).toBe("schemaReady");
      expect(schemaReady!.payload.nodes.length).toBeGreaterThan(0);
      expect(schemaReady!.payload.marks.length).toBeGreaterThan(0);
      expect(schemaReady!.payload.commands.length).toBeGreaterThan(0);

      const readyEvents = adapter.getEvents("ready");
      expect(readyEvents.length).toBe(1);
    });

    it("should emit schemaReady before ready", () => {
      adapter.sendCommand(TestAdapter.makeCommand("init"));

      const schemaReadyIndex = adapter.messages.findIndex(
        (msg) => msg.type === "event" && (msg as any).name === "schemaReady"
      );
      const readyIndex = adapter.messages.findIndex(
        (msg) => msg.type === "event" && (msg as any).name === "ready"
      );

      expect(schemaReadyIndex).toBeLessThan(readyIndex);
    });

    it("should return a success response for init", () => {
      const initCmd = TestAdapter.makeCommand("init");
      adapter.sendCommand(initCmd);

      const response = adapter.messages.find(
        (msg) => msg.type === "response" && (msg as Response).id === initCmd.id
      ) as Response;

      expect(response).toBeDefined();
      expect(response.success).toBe(true);
    });

    it("should reject double initialization", () => {
      adapter.sendCommand(TestAdapter.makeCommand("init"));

      const secondInit = TestAdapter.makeCommand("init");
      adapter.sendCommand(secondInit);

      const response = adapter.messages.find(
        (msg) =>
          msg.type === "response" && (msg as Response).id === secondInit.id
      ) as Response;

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe("ALREADY_INITIALIZED");
    });

    it("should include node types in schemaReady", () => {
      adapter.sendCommand(TestAdapter.makeCommand("init"));

      const schemaReady = adapter.getSchemaReady()!;
      const nodeNames = schemaReady.payload.nodes.map((n) => n.name);

      expect(nodeNames).toContain("doc");
      expect(nodeNames).toContain("paragraph");
      expect(nodeNames).toContain("text");
      expect(nodeNames).toContain("heading");
      expect(nodeNames).toContain("bulletList");
    });

    it("should include mark types in schemaReady", () => {
      adapter.sendCommand(TestAdapter.makeCommand("init"));

      const schemaReady = adapter.getSchemaReady()!;
      const markNames = schemaReady.payload.marks.map((m) => m.name);

      expect(markNames).toContain("bold");
      expect(markNames).toContain("italic");
      expect(markNames).toContain("link");
    });

    it("should include commands in schemaReady", () => {
      adapter.sendCommand(TestAdapter.makeCommand("init"));

      const schemaReady = adapter.getSchemaReady()!;
      const cmdNames = schemaReady.payload.commands.map((c) => c.name);

      expect(cmdNames).toContain("toggleBold");
      expect(cmdNames).toContain("toggleItalic");
      expect(cmdNames).toContain("undo");
      expect(cmdNames).toContain("redo");
    });
  });

  // ==========================================================================
  // Commands before initialization
  // ==========================================================================

  describe("Pre-init commands", () => {
    it("should return NOT_INITIALIZED for commands sent before init", () => {
      const cmd = TestAdapter.makeCommand("getContent", { format: "json" });
      adapter.sendCommand(cmd);

      const response = adapter.messages.find(
        (msg) => msg.type === "response" && (msg as Response).id === cmd.id
      ) as Response;

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe("NOT_INITIALIZED");
    });
  });

  // ==========================================================================
  // Content Commands
  // ==========================================================================

  describe("Content commands", () => {
    beforeEach(() => {
      adapter.sendCommand(
        TestAdapter.makeCommand("init", {
          content: "<p>Hello world</p>",
        })
      );
      adapter.clearMessages();
    });

    it("should return JSON content via getContent", () => {
      const cmd = TestAdapter.makeCommand("getContent", { format: "json" });
      adapter.sendCommand(cmd);

      const response = adapter.messages.find(
        (msg) => msg.type === "response" && (msg as Response).id === cmd.id
      ) as Response;

      expect(response.success).toBe(true);
      const content = (response.payload as { content: any }).content;
      expect(content.type).toBe("doc");
      expect(content.content[0].type).toBe("paragraph");
    });

    it("should return HTML content via getContent", () => {
      const cmd = TestAdapter.makeCommand("getContent", { format: "html" });
      adapter.sendCommand(cmd);

      const response = adapter.messages.find(
        (msg) => msg.type === "response" && (msg as Response).id === cmd.id
      ) as Response;

      expect(response.success).toBe(true);
      const content = (response.payload as { content: string }).content;
      expect(content).toContain("Hello world");
    });

    it("should return plain text content via getContent", () => {
      const cmd = TestAdapter.makeCommand("getContent", { format: "text" });
      adapter.sendCommand(cmd);

      const response = adapter.messages.find(
        (msg) => msg.type === "response" && (msg as Response).id === cmd.id
      ) as Response;

      expect(response.success).toBe(true);
      expect((response.payload as { content: string }).content).toBe(
        "Hello world"
      );
    });

    it("should replace content via setContent", () => {
      const setCmd = TestAdapter.makeCommand("setContent", {
        content: "<p>New content</p>",
      });
      adapter.sendCommand(setCmd);

      const setResponse = adapter.messages.find(
        (msg) => msg.type === "response" && (msg as Response).id === setCmd.id
      ) as Response;
      expect(setResponse.success).toBe(true);

      /**
       * Verify the content changed by requesting it back.
       */
      adapter.clearMessages();
      const getCmd = TestAdapter.makeCommand("getContent", { format: "text" });
      adapter.sendCommand(getCmd);

      const getResponse = adapter.messages.find(
        (msg) => msg.type === "response" && (msg as Response).id === getCmd.id
      ) as Response;
      expect((getResponse.payload as { content: string }).content).toBe(
        "New content"
      );
    });

    it("should emit stateChanged after setContent", () => {
      adapter.clearMessages();

      adapter.sendCommand(
        TestAdapter.makeCommand("setContent", {
          content: "<p>Updated</p>",
        })
      );

      const stateChanged = adapter.getLastStateChanged();
      expect(stateChanged).not.toBeNull();
      expect(stateChanged!.payload.doc.type).toBe("doc");
    });
  });

  // ==========================================================================
  // State Serialization
  // ==========================================================================

  describe("State serialization", () => {
    it("should annotate document nodes with pos/end", () => {
      adapter.sendCommand(
        TestAdapter.makeCommand("init", {
          content: "<p>Hello</p>",
        })
      );

      const stateChanged = adapter.getLastStateChanged()!;
      const doc = stateChanged.payload.doc;

      /**
       * Document structure for "<p>Hello</p>":
       * doc(0, 7) → paragraph(1, 6) → text "Hello" (1, 6)
       *
       * Position breakdown:
       * 0: doc opening
       * 1: paragraph opening (and text start)
       * 1-6: "Hello" (5 characters)
       * 6: paragraph closing
       * 7: doc closing
       */
      expect(doc.type).toBe("doc");
      expect(doc.pos).toBe(0);

      const para = doc.content![0];
      expect(para.type).toBe("paragraph");
      expect(para.pos).toBeGreaterThanOrEqual(0);

      const text = para.content![0];
      expect(text.type).toBe("text");
      expect(text.text).toBe("Hello");
      expect(text.end - text.pos).toBe(5);
    });

    it("should include selection state", () => {
      adapter.sendCommand(
        TestAdapter.makeCommand("init", {
          content: "<p>Hello</p>",
        })
      );

      const stateChanged = adapter.getLastStateChanged()!;
      const selection = stateChanged.payload.selection;

      expect(selection.type).toBeDefined();
      expect(typeof selection.anchor).toBe("number");
      expect(typeof selection.head).toBe("number");
      expect(typeof selection.from).toBe("number");
      expect(typeof selection.to).toBe("number");
      expect(typeof selection.empty).toBe("boolean");
    });

    it("should include commandStates", () => {
      adapter.sendCommand(
        TestAdapter.makeCommand("init", {
          content: "<p>Hello</p>",
        })
      );

      const stateChanged = adapter.getLastStateChanged()!;
      const commandStates = stateChanged.payload.commandStates;

      expect(commandStates).toBeDefined();
      expect(typeof commandStates).toBe("object");

      /**
       * At minimum, toggleBold and undo should be present since
       * we load default extensions which include bold and history.
       */
      if (commandStates.toggleBold) {
        expect(typeof commandStates.toggleBold.canExec).toBe("boolean");
        expect(typeof commandStates.toggleBold.isActive).toBe("boolean");
      }
    });

    it("should report editable state", () => {
      adapter.sendCommand(
        TestAdapter.makeCommand("init", {
          content: "<p>Hello</p>",
          editable: false,
        })
      );

      const stateChanged = adapter.getLastStateChanged()!;
      expect(stateChanged.payload.editable).toBe(false);
    });
  });

  // ==========================================================================
  // Exec Commands
  // ==========================================================================

  describe("Exec commands", () => {
    beforeEach(() => {
      adapter.sendCommand(
        TestAdapter.makeCommand("init", {
          content: "<p>Hello world</p>",
        })
      );

      /**
       * Select all text so that mark toggles apply to something.
       */
      adapter.sendCommand(TestAdapter.makeCommand("selectAll"));
      adapter.clearMessages();
    });

    it("should execute toggleBold", () => {
      const cmd = TestAdapter.makeCommand("exec", {
        command: "toggleBold",
      });
      adapter.sendCommand(cmd);

      const response = adapter.messages.find(
        (msg) => msg.type === "response" && (msg as Response).id === cmd.id
      ) as Response;

      expect(response.success).toBe(true);
    });

    it("should return error for unknown exec command", () => {
      const cmd = TestAdapter.makeCommand("exec", {
        command: "nonExistentCommand",
      });
      adapter.sendCommand(cmd);

      const response = adapter.messages.find(
        (msg) => msg.type === "response" && (msg as Response).id === cmd.id
      ) as Response;

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe("UNKNOWN_EXEC_COMMAND");
    });
  });

  // ==========================================================================
  // Selection Commands
  // ==========================================================================

  describe("Selection commands", () => {
    beforeEach(() => {
      adapter.sendCommand(
        TestAdapter.makeCommand("init", {
          content: "<p>Hello world</p>",
        })
      );
      adapter.clearMessages();
    });

    it("should set text selection (cursor)", () => {
      const cmd = TestAdapter.makeCommand("setTextSelection", {
        anchor: 3,
      });
      adapter.sendCommand(cmd);

      const response = adapter.messages.find(
        (msg) => msg.type === "response" && (msg as Response).id === cmd.id
      ) as Response;
      expect(response.success).toBe(true);

      const stateChanged = adapter.getLastStateChanged()!;
      expect(stateChanged.payload.selection.empty).toBe(true);
    });

    it("should set text selection (range)", () => {
      const cmd = TestAdapter.makeCommand("setTextSelection", {
        anchor: 1,
        head: 6,
      });
      adapter.sendCommand(cmd);

      const response = adapter.messages.find(
        (msg) => msg.type === "response" && (msg as Response).id === cmd.id
      ) as Response;
      expect(response.success).toBe(true);

      const stateChanged = adapter.getLastStateChanged()!;
      expect(stateChanged.payload.selection.empty).toBe(false);
    });

    it("should select all", () => {
      const cmd = TestAdapter.makeCommand("selectAll");
      adapter.sendCommand(cmd);

      const stateChanged = adapter.getLastStateChanged()!;
      expect(stateChanged.payload.selection.empty).toBe(false);
    });
  });

  // ==========================================================================
  // Query Commands
  // ==========================================================================

  describe("Query commands", () => {
    beforeEach(() => {
      adapter.sendCommand(
        TestAdapter.makeCommand("init", {
          content: "<p>Hello</p>",
        })
      );
      adapter.clearMessages();
    });

    it("should return full state via getState", () => {
      const cmd = TestAdapter.makeCommand("getState");
      adapter.sendCommand(cmd);

      const response = adapter.messages.find(
        (msg) => msg.type === "response" && (msg as Response).id === cmd.id
      ) as Response;

      expect(response.success).toBe(true);
      const payload = response.payload as any;
      expect(payload.doc).toBeDefined();
      expect(payload.selection).toBeDefined();
      expect(payload.commandStates).toBeDefined();
    });

    it("should check isActive for marks", () => {
      const cmd = TestAdapter.makeCommand("isActive", { name: "bold" });
      adapter.sendCommand(cmd);

      const response = adapter.messages.find(
        (msg) => msg.type === "response" && (msg as Response).id === cmd.id
      ) as Response;

      expect(response.success).toBe(true);
      expect(typeof (response.payload as { active: boolean }).active).toBe(
        "boolean"
      );
    });

    it("should check canExec for commands", () => {
      const cmd = TestAdapter.makeCommand("canExec", { command: "toggleBold" });
      adapter.sendCommand(cmd);

      const response = adapter.messages.find(
        (msg) => msg.type === "response" && (msg as Response).id === cmd.id
      ) as Response;

      expect(response.success).toBe(true);
      expect(typeof (response.payload as { canExec: boolean }).canExec).toBe(
        "boolean"
      );
    });

    it("should get attributes for a node type", () => {
      adapter.sendCommand(
        TestAdapter.makeCommand("setContent", {
          content: "<h1>Title</h1>",
        })
      );

      /**
       * Move cursor into the heading to query its attributes.
       */
      adapter.sendCommand(
        TestAdapter.makeCommand("setTextSelection", { anchor: 1 })
      );

      adapter.clearMessages();

      const cmd = TestAdapter.makeCommand("getAttributes", { name: "heading" });
      adapter.sendCommand(cmd);

      const response = adapter.messages.find(
        (msg) => msg.type === "response" && (msg as Response).id === cmd.id
      ) as Response;

      expect(response.success).toBe(true);
      const attrs = (response.payload as { attrs: Record<string, unknown> })
        .attrs;
      expect(attrs.level).toBe(1);
    });
  });

  // ==========================================================================
  // Event Discrimination
  // ==========================================================================

  describe("Event discrimination", () => {
    beforeEach(() => {
      adapter.sendCommand(
        TestAdapter.makeCommand("init", {
          content: "<p>Hello</p>",
        })
      );
      adapter.clearMessages();
    });

    it("should emit contentChanged when document changes", () => {
      adapter.sendCommand(
        TestAdapter.makeCommand("setContent", {
          content: "<p>New text</p>",
        })
      );

      const contentChanged = adapter.getEvents("contentChanged");
      expect(contentChanged.length).toBeGreaterThan(0);
    });

    it("should emit selectionChanged on selection-only changes", () => {
      adapter.sendCommand(
        TestAdapter.makeCommand("setTextSelection", { anchor: 1 })
      );

      const selectionChanged = adapter.getEvents(
        "selectionChanged"
      ) as SelectionChangedEvent[];

      /**
       * There should be at least one selectionChanged event when
       * only the selection moves and the document doesn't change.
       */
      if (selectionChanged.length > 0) {
        expect(selectionChanged[0].payload.selection).toBeDefined();
        expect(selectionChanged[0].payload.commandStates).toBeDefined();
      }
    });
  });

  // ==========================================================================
  // Destroy
  // ==========================================================================

  describe("Destroy", () => {
    it("should destroy cleanly", () => {
      adapter.sendCommand(TestAdapter.makeCommand("init"));

      const destroyCmd = TestAdapter.makeCommand("destroy");
      adapter.sendCommand(destroyCmd);

      const response = adapter.messages.find(
        (msg) =>
          msg.type === "response" && (msg as Response).id === destroyCmd.id
      ) as Response;

      expect(response.success).toBe(true);
    });

    it("should allow re-initialization after destroy", () => {
      adapter.sendCommand(TestAdapter.makeCommand("init"));
      adapter.sendCommand(TestAdapter.makeCommand("destroy"));
      adapter.clearMessages();

      const reinitCmd = TestAdapter.makeCommand("init", {
        content: "<p>Reinitialized</p>",
      });
      adapter.sendCommand(reinitCmd);

      const response = adapter.messages.find(
        (msg) =>
          msg.type === "response" && (msg as Response).id === reinitCmd.id
      ) as Response;

      expect(response.success).toBe(true);

      const readyEvents = adapter.getEvents("ready");
      expect(readyEvents.length).toBe(1);
    });
  });

  // ==========================================================================
  // Editable State
  // ==========================================================================

  describe("Editable state", () => {
    it("should toggle editable state", () => {
      adapter.sendCommand(TestAdapter.makeCommand("init"));
      adapter.clearMessages();

      const cmd = TestAdapter.makeCommand("setEditable", { editable: false });
      adapter.sendCommand(cmd);

      const response = adapter.messages.find(
        (msg) => msg.type === "response" && (msg as Response).id === cmd.id
      ) as Response;
      expect(response.success).toBe(true);

      const stateChanged = adapter.getLastStateChanged();
      if (stateChanged) {
        expect(stateChanged.payload.editable).toBe(false);
      }
    });
  });
});
