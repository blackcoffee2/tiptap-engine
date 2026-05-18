// ============================================================================
// Keyboard Action Command Tests
//
// Tests for the backspace and enter protocol commands. These commands
// delegate to TipTap's keyboardShortcut() which runs ProseMirror's full
// keybinding chain, giving ports correct structural behavior without
// needing to understand the document model.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TiptapEngine } from "../src/core/engine";
import { TestAdapter } from "./test-adapter";
import type { Response, StateChangedEvent } from "../src/types/protocol";

describe("Keyboard action commands", () => {
  let adapter: TestAdapter;
  let engine: TiptapEngine;

  beforeEach(() => {
    adapter = new TestAdapter();
    engine = new TiptapEngine(adapter);
    adapter.initialize();
  });

  afterEach(() => {
    try {
      adapter.sendCommand(TestAdapter.makeCommand("destroy"));
    } catch {
      /* Engine may not have been initialized in all tests */
    }
    adapter.destroy();
  });

  // ==========================================================================
  // Backspace
  // ==========================================================================

  describe("backspace", () => {
    it("should return success response", () => {
      adapter.sendCommand(
        TestAdapter.makeCommand("init", {
          content: "<p>Hello</p>",
        })
      );

      /**
       * Place cursor at position 3 (after "He") so there's a character
       * to delete before the cursor.
       */
      adapter.sendCommand(
        TestAdapter.makeCommand("setTextSelection", { anchor: 3 })
      );
      adapter.clearMessages();

      const cmd = TestAdapter.makeCommand("backspace");
      adapter.sendCommand(cmd);

      const response = adapter.messages.find(
        (msg) => msg.type === "response" && (msg as Response).id === cmd.id
      ) as Response;

      expect(response).toBeDefined();
      expect(response.success).toBe(true);
    });

    it("should delete a character before the cursor", () => {
      adapter.sendCommand(
        TestAdapter.makeCommand("init", {
          content: "<p>Hello</p>",
        })
      );

      /**
       * Place cursor at position 6 (after "Hello", before paragraph close).
       * Backspace should remove the "o" at the end.
       */
      adapter.sendCommand(
        TestAdapter.makeCommand("setTextSelection", { anchor: 6 })
      );
      adapter.clearMessages();

      adapter.sendCommand(TestAdapter.makeCommand("backspace"));

      /**
       * Verify the document changed by fetching text content.
       */
      adapter.clearMessages();
      const getCmd = TestAdapter.makeCommand("getContent", { format: "text" });
      adapter.sendCommand(getCmd);

      const response = adapter.messages.find(
        (msg) => msg.type === "response" && (msg as Response).id === getCmd.id
      ) as Response;

      expect((response.payload as { content: string }).content).toBe("Hell");
    });

    it("should delete selected text when selection is non-empty", () => {
      adapter.sendCommand(
        TestAdapter.makeCommand("init", {
          content: "<p>Hello world</p>",
        })
      );

      /**
       * Select "Hello" (positions 1-6).
       */
      adapter.sendCommand(
        TestAdapter.makeCommand("setTextSelection", { anchor: 1, head: 6 })
      );
      adapter.clearMessages();

      adapter.sendCommand(TestAdapter.makeCommand("backspace"));

      adapter.clearMessages();
      const getCmd = TestAdapter.makeCommand("getContent", { format: "text" });
      adapter.sendCommand(getCmd);

      const response = adapter.messages.find(
        (msg) => msg.type === "response" && (msg as Response).id === getCmd.id
      ) as Response;

      expect((response.payload as { content: string }).content).toBe(" world");
    });

    it("should emit contentChanged event", () => {
      adapter.sendCommand(
        TestAdapter.makeCommand("init", {
          content: "<p>Hello</p>",
        })
      );
      adapter.sendCommand(
        TestAdapter.makeCommand("setTextSelection", { anchor: 6 })
      );
      adapter.clearMessages();

      adapter.sendCommand(TestAdapter.makeCommand("backspace"));

      const contentChanged = adapter.getEvents("contentChanged");
      expect(contentChanged.length).toBeGreaterThan(0);
    });

    it("should join blocks when at the start of a paragraph", () => {
      adapter.sendCommand(
        TestAdapter.makeCommand("init", {
          content: "<p>First</p><p>Second</p>",
        })
      );

      /**
       * Position the cursor at the start of the second paragraph.
       * For "<p>First</p><p>Second</p>":
       *   doc(0) → p(1, "First", 6) → p(8, "Second", 14)
       * Position 8 is the start of the second paragraph's content.
       */
      adapter.sendCommand(
        TestAdapter.makeCommand("setTextSelection", { anchor: 8 })
      );
      adapter.clearMessages();

      adapter.sendCommand(TestAdapter.makeCommand("backspace"));

      /**
       * The two paragraphs should be joined into one.
       */
      adapter.clearMessages();
      const getCmd = TestAdapter.makeCommand("getContent", { format: "text" });
      adapter.sendCommand(getCmd);

      const response = adapter.messages.find(
        (msg) => msg.type === "response" && (msg as Response).id === getCmd.id
      ) as Response;

      expect((response.payload as { content: string }).content).toBe(
        "FirstSecond"
      );
    });

    it("should return NOT_INITIALIZED when engine is not initialized", () => {
      const cmd = TestAdapter.makeCommand("backspace");
      adapter.sendCommand(cmd);

      const response = adapter.messages.find(
        (msg) => msg.type === "response" && (msg as Response).id === cmd.id
      ) as Response;

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe("NOT_INITIALIZED");
    });
  });

  // ==========================================================================
  // Enter
  // ==========================================================================

  describe("enter", () => {
    it("should return success response", () => {
      adapter.sendCommand(
        TestAdapter.makeCommand("init", {
          content: "<p>Hello</p>",
        })
      );
      adapter.sendCommand(
        TestAdapter.makeCommand("setTextSelection", { anchor: 3 })
      );
      adapter.clearMessages();

      const cmd = TestAdapter.makeCommand("enter");
      adapter.sendCommand(cmd);

      const response = adapter.messages.find(
        (msg) => msg.type === "response" && (msg as Response).id === cmd.id
      ) as Response;

      expect(response).toBeDefined();
      expect(response.success).toBe(true);
    });

    it("should split a paragraph into two", () => {
      adapter.sendCommand(
        TestAdapter.makeCommand("init", {
          content: "<p>HelloWorld</p>",
        })
      );

      /**
       * Place cursor between "Hello" and "World" (position 6).
       */
      adapter.sendCommand(
        TestAdapter.makeCommand("setTextSelection", { anchor: 6 })
      );
      adapter.clearMessages();

      adapter.sendCommand(TestAdapter.makeCommand("enter"));

      /**
       * Verify the document now has two paragraphs by checking the
       * document structure in the stateChanged event.
       */
      const stateChanged = adapter.getLastStateChanged();
      expect(stateChanged).not.toBeNull();

      const doc = stateChanged!.payload.doc;
      const paragraphs = doc.content!.filter((n) => n.type === "paragraph");
      expect(paragraphs.length).toBe(2);
    });

    it("should emit contentChanged event", () => {
      adapter.sendCommand(
        TestAdapter.makeCommand("init", {
          content: "<p>Hello</p>",
        })
      );
      adapter.sendCommand(
        TestAdapter.makeCommand("setTextSelection", { anchor: 3 })
      );
      adapter.clearMessages();

      adapter.sendCommand(TestAdapter.makeCommand("enter"));

      const contentChanged = adapter.getEvents("contentChanged");
      expect(contentChanged.length).toBeGreaterThan(0);
    });

    it("should split a list item when inside a list", () => {
      adapter.sendCommand(
        TestAdapter.makeCommand("init", {
          content: "<ul><li><p>Item one</p></li></ul>",
        })
      );

      /**
       * Place cursor after "Item" inside the list item.
       * For "<ul><li><p>Item one</p></li></ul>":
       *   doc(0) → bulletList(1) → listItem(2) → paragraph(3) → text(3, "Item one", 11)
       * Position 7 is between "Item" and " one".
       */
      adapter.sendCommand(
        TestAdapter.makeCommand("setTextSelection", { anchor: 7 })
      );
      adapter.clearMessages();

      adapter.sendCommand(TestAdapter.makeCommand("enter"));

      /**
       * The list should now have two list items. Verify by checking
       * the document structure.
       */
      const stateChanged = adapter.getLastStateChanged();
      expect(stateChanged).not.toBeNull();

      const doc = stateChanged!.payload.doc;
      const bulletList = doc.content!.find((n) => n.type === "bulletList");
      expect(bulletList).toBeDefined();

      const listItems = bulletList!.content!.filter(
        (n) => n.type === "listItem"
      );
      expect(listItems.length).toBe(2);
    });

    it("should lift an empty list item out of the list", () => {
      adapter.sendCommand(
        TestAdapter.makeCommand("init", {
          content: "<ul><li><p>Item</p></li><li><p></p></li></ul>",
        })
      );

      /**
       * Place cursor in the empty second list item.
       * The empty paragraph inside the second list item has its content
       * start position right after the paragraph opening token.
       * For this document structure we need to find where that empty
       * paragraph is and place the cursor there.
       */
      const stateAfterInit = adapter.getLastStateChanged()!;
      const doc = stateAfterInit.payload.doc;
      const bulletList = doc.content!.find((n) => n.type === "bulletList")!;
      const secondListItem = bulletList.content![1];
      const emptyParagraph = secondListItem.content![0];

      /**
       * Position cursor at the start of the empty paragraph content.
       */
      adapter.sendCommand(
        TestAdapter.makeCommand("setTextSelection", {
          anchor: emptyParagraph.pos + 1,
        })
      );
      adapter.clearMessages();

      adapter.sendCommand(TestAdapter.makeCommand("enter"));

      /**
       * Pressing enter on an empty list item should lift it out of the
       * list and convert it to a paragraph. The resulting document should
       * have a list with one item followed by a paragraph.
       */
      const stateChanged = adapter.getLastStateChanged();
      expect(stateChanged).not.toBeNull();

      const updatedDoc = stateChanged!.payload.doc;
      const topLevelTypes = updatedDoc.content!.map((n) => n.type);

      /**
       * After lifting, we expect the list to have lost its empty item
       * and a new paragraph to appear at the top level.
       */
      expect(topLevelTypes).toContain("paragraph");
    });

    it("should return NOT_INITIALIZED when engine is not initialized", () => {
      const cmd = TestAdapter.makeCommand("enter");
      adapter.sendCommand(cmd);

      const response = adapter.messages.find(
        (msg) => msg.type === "response" && (msg as Response).id === cmd.id
      ) as Response;

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe("NOT_INITIALIZED");
    });
  });
});
