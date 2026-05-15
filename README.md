# Tiptap Engine

A headless Tiptap runtime that exposes a platform-agnostic message-based API for native rich text editors. It runs unmodified Tiptap v3 and ProseMirror JavaScript inside the OS-provided WebView (WKWebView on iOS, Chromium-based WebView on Android) and pushes structured document state out through a JSON protocol.

ProseMirror requires a real browser DOM — `document.createElement`, `Node.childNodes`, DOM mutation observers, and more. The OS WebView provides all of this for free. The WebView is invisible — a computation engine only. No pixels from the WebView ever reach the user's eyes. The native platform paints every pixel and handles every keystroke.

For testing and CI, the engine also runs in Node.js with jsdom providing a synthetic DOM environment.

For the full protocol reference, see [API.md](./API.md).

---

## Table of Contents

- [Motivation](#motivation)
- [How It Works](#how-it-works)
- [Quick Start](#quick-start)
- [Build Output](#build-output)
- [Protocol Overview](#protocol-overview)
- [Adapters](#adapters)
- [Extensions](#extensions)
- [Performance](#performance)
- [Key Files](#key-files)
- [Tiptap Version](#tiptap-version)
- [Building a Port](#building-a-port)
- [Tests](#tests)
- [License](#license)

---

## Motivation

Tiptap is built on ProseMirror, which is coupled to the browser DOM at every layer:

- **EditorView** uses DOM mutation observers, `contentEditable`, and browser input events
- **parseDOM / toDOM** on every extension calls `document.createElement`, CSS selectors, etc.
- **DOMParser / DOMSerializer** are built around browser DOM APIs
- **Input handling** intercepts `beforeinput`, composition events, clipboard events

A native port of ProseMirror would require reimplementing the document model, transaction system, schema, and every extension from scratch — a multi-year effort. Every existing Tiptap extension would also need rewriting, removing the ecosystem compatibility that makes Tiptap valuable.

This engine takes a different approach: run the original JavaScript in a headless WebView and expose the editor's state through a structured protocol. Existing extensions work unmodified. The native platform handles rendering, input, and UI.

### Comparison With Visible WebView Approaches

Projects like 10tap-editor (React Native) embed a visible WebView where ProseMirror renders to screen and handles input. This introduces keyboard conflicts, scroll synchronization issues, focus management problems, and platform-inconsistent behavior.

This engine keeps the WebView entirely invisible. The native platform's text input system, widget rendering, and gesture handling are used exclusively. From the user's perspective, the editor is indistinguishable from a native component.

---

## How It Works

```
Native Port (Flutter, Swift, Kotlin, etc.)
  Renders widgets, handles input, paints cursor/selection
       |
       |  JSON commands down, JSON events up
       v
Tiptap Engine (headless WebView)
  Adapter --> Engine --> Tiptap/ProseMirror
  Hidden DOM element, no visible rendering
```

The engine creates a real Tiptap editor instance mounted on a hidden DOM element inside the WebView. ProseMirror operates normally — schema validation, transaction processing, plugin lifecycle, input rules, paste rules — but nothing is ever painted to screen.

On every transaction, the engine serializes the document into annotated JSON with ProseMirror position offsets (`pos`/`end`) on every node. This annotated tree, along with selection state, active marks, and command states, is pushed to the native port as a `stateChanged` event.

**The engine owns:**

- Document model, schema, state, transforms
- Transaction processing and plugin lifecycle
- Extension loading and configuration
- Command execution (the full Tiptap command system)
- Input rules and paste rules
- Undo/redo history
- Content parsing and serialization (HTML, JSON)
- Schema introspection and command discovery

**The engine does not own:**

- Rendering pixels to screen
- Capturing keystrokes or touch input
- Clipboard access
- Toolbar UI or any visual components
- Selection painting and cursor blinking
- Scroll behavior

---

## Quick Start

```bash
npm install
npm run build
npm test
```

For manual verification in a browser, open `dist/test.html` after building and click "Run All Tests". This exercises the full protocol through the browser postMessage adapter.

---

## Build Output

After `npm run build`, the `dist/` folder contains:

| File                   | Description                                          |
| ---------------------- | ---------------------------------------------------- |
| `tiptap-engine.js`     | Self-executing IIFE bundle. Load in a WebView.       |
| `tiptap-engine.js.map` | Source map for debugging. Do not ship to production. |
| `tiptap-engine.html`   | Minimal HTML shell for WebView-based ports.          |
| `test.html`            | Browser test harness for manual verification.        |

Approximate bundle size (may vary with dependency updates):

| Metric   | Size    |
| -------- | ------- |
| Minified | ~430 KB |
| Gzipped  | ~130 KB |

The bundle is loaded from the device filesystem, not over a network. Parse time on modern iOS and Android devices is sub-second.

---

## Protocol Overview

All communication is JSON messages. The engine receives **commands**, returns **responses** (correlated by `id`), and pushes **events** asynchronously.

See [API.md](./API.md) for the complete reference with every command, event, and response documented.

### Message Types

**Commands** (Port to Engine) — Requests to mutate or query editor state. Every command carries a unique `id` for response correlation.

**Responses** (Engine to Port) — Correlated to commands by `id`. Contains `success` boolean, optional `payload`, optional `error`.

**Events** (Engine to Port) — Pushed asynchronously on state changes. Not correlated to any specific command.

### Initialization Sequence

```
Port sends:    init { content, extensions, editable }
Engine emits:  schemaReady { nodes, marks, commands }
Engine emits:  ready {}
Engine emits:  stateChanged { doc, selection, activeMarks, commandStates, ... }
Engine sends:  response { id, success: true }
```

### Position Annotations

Every node in the document JSON carries `pos` and `end` fields — ProseMirror document positions. These enable native hit-testing without the port needing to understand ProseMirror's position addressing:

1. The port hit-tests its widget tree to find the tapped text node
2. Uses text layout APIs to find the character offset within that node
3. Adds the offset to the node's `pos` to get the document position
4. Sends `setTextSelection` to the engine

```json
{
  "type": "paragraph",
  "pos": 1,
  "end": 15,
  "content": [
    { "type": "text", "pos": 2, "end": 8, "text": "Hello " },
    {
      "type": "text",
      "pos": 8,
      "end": 13,
      "text": "world",
      "marks": [{ "type": "bold" }]
    }
  ]
}
```

### Command States

Every `stateChanged` event includes a `commandStates` map that drives toolbar UI. Each entry reports whether a command can execute and whether its associated mark or node is active:

```json
{
  "toggleBold": { "canExec": true, "isActive": true },
  "toggleItalic": { "canExec": true, "isActive": false },
  "undo": { "canExec": true, "isActive": false, "depth": 3 },
  "redo": { "canExec": false, "isActive": false, "depth": 0 }
}
```

---

## Adapters

The engine communicates through adapters that handle platform-specific transport.

### WebView Adapter

Used in production by native ports. Detects the platform automatically:

| Platform | Engine to Port (outbound)                                      | Port to Engine (inbound)                                 |
| -------- | -------------------------------------------------------------- | -------------------------------------------------------- |
| iOS      | `window.webkit.messageHandlers.TiptapEngine.postMessage(json)` | `evaluateJavaScript('TiptapEngine.handleCommand(...)')`  |
| Android  | `window.TiptapBridge.postMessage(json)`                        | `evaluateJavascript('TiptapEngine.handleCommand(...)')`  |
| Browser  | `window.postMessage({ source: 'tiptap-engine', message })`     | `window.postMessage({ source: 'tiptap-port', message })` |

### Node Adapter

Uses `stdin`/`stdout` with newline-delimited JSON (NDJSON). Used for testing and CI with jsdom providing a synthetic DOM — Node.js alone has no DOM, so this is not a production runtime path.

### Test Adapter

In-memory adapter for unit tests. Collects all outbound messages in an array with helper methods for assertions.

---

## Extensions

The engine bundles all official open-source Tiptap v3 extensions. Users opt in/out by name in the `init` command. If no extensions are specified, the full default set is loaded.

The default set includes everything from StarterKit v3 (Blockquote, BulletList, CodeBlock, Document, HardBreak, Heading, HorizontalRule, ListItem, OrderedList, Paragraph, Text, Bold, Code, Italic, Link, Strike, Underline, Dropcursor, Gapcursor, UndoRedo, ListKeymap, TrailingNode) plus additional extensions (TextAlign, Image, Placeholder, Color, TextStyle, Table, Superscript, Subscript, Highlight, TaskList, Typography, CharacterCount). The authoritative list is the `DEFAULT_EXTENSIONS` array in `src/extensions/registry.ts`.

### Dependency Resolution

Extensions declare dependencies. Enabling `table` automatically includes `tableRow`, `tableCell`, and `tableHeader`. Enabling `taskList` automatically includes `taskItem`. Enabling `color` automatically includes `textStyle`.

### Custom Configuration

Extensions can be configured through the `init` command:

```json
{
  "extensions": [
    { "name": "heading", "options": { "levels": [1, 2, 3] } },
    { "name": "link", "options": { "openOnClick": false } },
    { "name": "placeholder", "options": { "placeholder": "Start writing..." } }
  ]
}
```

---

## Performance

The engine is designed for sub-frame-budget latency on every keystroke. The full round-trip — from native input capture to widget rebuild — must complete within one frame (16ms at 60fps) for the editor to feel native.

### Per-Keystroke Round-Trip

| Step                                      | Expected Time |
| ----------------------------------------- | ------------- |
| Native platform captures input            | < 1ms         |
| Send JSON command to WebView              | ~ 1ms         |
| Tiptap processes the transaction          | < 1ms         |
| Serialize annotated document JSON         | < 1ms         |
| Send JSON event back to native            | ~ 1ms         |
| Native platform rebuilds affected widgets | < 1ms         |
| **Total**                                 | **< 6ms**     |

This leaves substantial headroom within the 16ms frame budget.

### Startup

The engine bundle loads from the device filesystem (not over network). On tested devices, the full initialization sequence — WebView creation, JS parse and execute, Tiptap editor instantiation, schema introspection, initial state serialization — completes in under one second.

### Large Documents

For typical documents (under 100KB of content), the full document JSON serialization through the bridge adds negligible overhead. For very large documents (50+ pages), a diff-mode optimization (sending only changed nodes per transaction) is designed for but not yet implemented. The current full-state approach is sufficient for the vast majority of editing use cases.

---

## Key Files

**`src/types/protocol.ts`** — The contract. Defines every command, event, response, and state type. Port implementations generate their own typed models from these definitions. This is the single source of truth for the protocol.

**`src/core/engine.ts`** — The orchestration class. Receives commands from the adapter, dispatches them to Tiptap, hooks into `onTransaction` to serialize state updates, and pushes events back through the adapter.

**`src/core/state-serializer.ts`** — Converts ProseMirror's internal document representation into the annotated JSON format with `pos`/`end` on every node. This is what makes native hit-testing possible without the port needing to understand ProseMirror's position addressing.

**`src/extensions/registry.ts`** — Maps extension name strings to Tiptap extension constructors. Handles dependency resolution and default configuration. Uses Tiptap v3's consolidated package structure (`@tiptap/extension-list`, `@tiptap/extension-table`, `@tiptap/extensions`).

**`src/core/command-registry.ts`** — Discovers all available commands from loaded extensions and attaches behavioral metadata (toggle-mark, toggle-node, wrap, lift, action) for toolbar auto-generation. Maintains a manual metadata table for known commands since Tiptap's command system does not carry rich metadata natively.

**`src/core/schema-inspector.ts`** — Extracts node type and mark type metadata from the ProseMirror schema. Produces content expressions, groups, attributes, and structural flags for each type.

---

## Tiptap Version

Built on Tiptap v3 (^3.23.4). Uses the v3 consolidated package structure:

| Package                   | Contents                                                                   |
| ------------------------- | -------------------------------------------------------------------------- |
| `@tiptap/extension-list`  | BulletList, OrderedList, ListItem, TaskList, TaskItem, ListKeymap          |
| `@tiptap/extension-table` | Table, TableRow, TableCell, TableHeader                                    |
| `@tiptap/extensions`      | UndoRedo, Dropcursor, Gapcursor, Placeholder, CharacterCount, TrailingNode |
| `@tiptap/core`            | Editor, Extension, Node, Mark base classes                                 |
| `@tiptap/pm`              | ProseMirror dependencies                                                   |

---

## Building a Port

The engine is designed so that anyone can build a native port for any platform. A port communicates with the engine exclusively through the JSON protocol — no direct access to ProseMirror internals is needed.

### Minimum Viable Port

The smallest useful port implements three things:

**1. Host the engine.** Load `tiptap-engine.html` into an invisible WebView. Establish the message channel (platform-specific JavaScript bridge for events, `evaluateJavaScript` for commands). Send an `init` command and wait for the `ready` event.

**2. Render the document.** Subscribe to `stateChanged` events. Walk the `doc` field (an `AnnotatedNode` tree) recursively, mapping node types to native widgets and marks to text styles. On every `stateChanged` event, rebuild the widget tree.

**3. Send user input.** When the user types, send `insertText` commands. When the user taps a toolbar button, send `exec` commands. When the user taps a position in the document, convert the pixel coordinate to a document position using the `pos`/`end` annotations and send `setTextSelection`.

### Initialization Flow in Pseudocode

```
webview = create_invisible_webview()
webview.load("tiptap-engine.html")
webview.register_js_channel("TiptapBridge", on_message)

function on_message(json):
    message = parse_json(json)
    if message.type == "event":
        if message.name == "schemaReady":
            store_schema(message.payload)
        if message.name == "ready":
            mark_engine_ready()
        if message.name == "stateChanged":
            rebuild_ui(message.payload)
    if message.type == "response":
        complete_pending_command(message.id, message)

function send_command(name, payload):
    id = generate_unique_id()
    json = to_json({ type: "command", id: id, name: name, payload: payload })
    webview.evaluate_js("TiptapEngine.handleCommand('" + escape(json) + "')")
    return wait_for_response(id)

// Start the editor
send_command("init", { content: "<p>Hello world</p>" })
```

### Rendering the Document Tree

The `stateChanged` event's `doc` field is a recursive tree. Each node has a `type` and optional `content` (children), `text`, `marks`, and `attrs`. A renderer walks this tree:

```
function render_node(node):
    if node.type == "doc":
        return vertical_list(node.content.map(render_node))
    if node.type == "paragraph":
        return rich_text(render_inline_content(node.content))
    if node.type == "heading":
        return rich_text(render_inline_content(node.content), scale: heading_scale(node.attrs.level))
    if node.type == "text":
        style = base_style
        for mark in node.marks:
            if mark.type == "bold": style = style.with(bold)
            if mark.type == "italic": style = style.with(italic)
            if mark.type == "link": style = style.with(color: blue, underline, tap: open(mark.attrs.href))
        return styled_text(node.text, style)
    ...
```

### Hit-Testing for Selection

When the user taps the rendered document, the port needs to convert a pixel coordinate to a ProseMirror document position:

```
function on_tap(x, y):
    // Find which text widget was tapped
    text_widget = hit_test(x, y)

    // Find the character offset within that text run
    local_offset = text_widget.get_character_offset(x, y)

    // The text widget was rendered from a node with a known pos
    doc_position = text_widget.source_node.pos + local_offset

    // Tell the engine where the cursor should go
    send_command("setTextSelection", { anchor: doc_position })
```

The `pos`/`end` annotations on every node make this possible without the port needing to recompute ProseMirror's position addressing.

### Toolbar

Read the `commandStates` map from each `stateChanged` event. Each toolbar button maps to a command name:

```
function build_toolbar(command_states):
    bold_button = toggle_button(
        enabled: command_states["toggleBold"].canExec,
        active: command_states["toggleBold"].isActive,
        on_tap: send_command("exec", { command: "toggleBold" })
    )
    undo_button = button(
        enabled: command_states["undo"].canExec,
        on_tap: send_command("exec", { command: "undo" })
    )
    ...
```

The `schemaReady` event provides metadata for auto-generating the toolbar — command types, groupings, and associated marks/nodes — so the port does not need to hardcode which extensions are available.

---

## Tests

Unit tests cover:

- Protocol type serialization and deserialization
- Engine lifecycle (init, destroy, reinit, double-init rejection)
- Content operations (get/set as JSON, HTML, plain text)
- State serialization with position annotations
- Command execution and error handling
- Selection management (cursor, range, selectAll)
- Query commands (isActive, canExec, getAttributes)
- Event discrimination (stateChanged vs contentChanged vs selectionChanged)
- Editable state toggling

A browser test harness (`dist/test.html`) verifies the full engine end-to-end through the real WebView adapter.

```bash
# Run unit tests
npm test

# Run in watch mode during development
npm run test:watch
```

---

## License

MIT — see [LICENSE](./LICENSE).
