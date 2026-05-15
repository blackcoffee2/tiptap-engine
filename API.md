# Tiptap Engine — API Reference

Complete protocol reference for port developers. Every command, event, and response is documented here with payload shapes and JSON examples.

All communication is JSON strings over the platform-specific bridge (WKWebView on iOS, Chromium-based WebView on Android, jsdom in Node.js for testing). Messages fall into three categories:

- **Commands** (Port to Engine): carry a unique `id`, return a response
- **Responses** (Engine to Port): correlated to commands by `id`
- **Events** (Engine to Port): pushed asynchronously, not correlated to commands

## Table of Contents

- [Message Format](#message-format)
- [Commands](#commands)
  - [Lifecycle](#lifecycle-commands)
  - [Content](#content-commands)
  - [Text Input](#text-input-commands)
  - [Generic Execution](#generic-execution)
  - [Selection](#selection-commands)
  - [Queries](#query-commands)
- [Events](#events)
- [Responses](#responses)
- [Data Types](#data-types)
- [Command Names for exec](#command-names-for-exec)

---

## Message Format

### Command (Port to Engine)

```json
{
  "type": "command",
  "id": "unique-string",
  "name": "commandName",
  "payload": {}
}
```

Every command must have a unique `id`. The engine returns a response with the same `id`. Use any string — UUIDs, incrementing counters, timestamps, anything unique within the session.

### Response (Engine to Port)

```json
{
  "type": "response",
  "id": "unique-string",
  "success": true,
  "payload": {},
  "error": { "code": "ERROR_CODE", "message": "Human-readable message" }
}
```

`payload` is present on success for query commands. `error` is present when `success` is `false`.

### Event (Engine to Port)

```json
{
  "type": "event",
  "name": "eventName",
  "payload": {}
}
```

Events have no `id`. They are pushed whenever state changes.

---

## Commands

### Lifecycle Commands

#### `init`

Create the editor. Must be the first command sent. Emits `schemaReady`, `ready`, and `stateChanged` events before the response.

**Payload:**

| Field        | Type                 | Required | Default                | Description                                   |
| ------------ | -------------------- | -------- | ---------------------- | --------------------------------------------- |
| `extensions` | `ExtensionConfig[]`  | No       | All default extensions | Extensions to enable                          |
| `content`    | `object` or `string` | No       | Empty document         | Initial content as Tiptap JSON or HTML string |
| `editable`   | `boolean`            | No       | `true`                 | Whether the editor starts in editable mode    |

`ExtensionConfig` shape: `{ "name": "string", "options": { } }`

**Example:**

```json
{
  "type": "command",
  "id": "1",
  "name": "init",
  "payload": {
    "content": "<p>Hello <strong>world</strong>!</p>",
    "editable": true
  }
}
```

**Response:** `{ "success": true }`

**Errors:**

- `ALREADY_INITIALIZED` — The engine is already initialized. Call `destroy` first.

---

#### `destroy`

Tear down the editor and clean up all resources. After this, the engine accepts a new `init` command.

**Payload:** None (empty object).

```json
{ "type": "command", "id": "2", "name": "destroy", "payload": {} }
```

**Response:** `{ "success": true }`

---

#### `setEditable`

Toggle read-only mode.

**Payload:**

| Field      | Type      | Required | Description                           |
| ---------- | --------- | -------- | ------------------------------------- |
| `editable` | `boolean` | Yes      | Whether the editor should be editable |

```json
{
  "type": "command",
  "id": "3",
  "name": "setEditable",
  "payload": { "editable": false }
}
```

**Response:** `{ "success": true }`

---

### Content Commands

#### `setContent`

Replace the entire document.

**Payload:**

| Field        | Type                 | Required | Default | Description                               |
| ------------ | -------------------- | -------- | ------- | ----------------------------------------- |
| `content`    | `object` or `string` | Yes      | —       | New content as Tiptap JSON or HTML string |
| `emitUpdate` | `boolean`            | No       | `true`  | Whether to emit a `stateChanged` event    |

```json
{
  "type": "command",
  "id": "4",
  "name": "setContent",
  "payload": {
    "content": "<h1>New Title</h1><p>New paragraph</p>"
  }
}
```

**Response:** `{ "success": true }`

---

#### `getContent`

Request the current document content in a specific format.

**Payload:**

| Field    | Type                             | Required | Description   |
| -------- | -------------------------------- | -------- | ------------- |
| `format` | `"json"` or `"html"` or `"text"` | Yes      | Output format |

```json
{
  "type": "command",
  "id": "5",
  "name": "getContent",
  "payload": { "format": "html" }
}
```

**Response:**

```json
{
  "success": true,
  "payload": {
    "content": "<p>Hello <strong>world</strong>!</p>"
  }
}
```

For `format: "json"`, `content` is a Tiptap JSON document object. For `format: "html"` and `format: "text"`, `content` is a string.

**Errors:**

- `INVALID_FORMAT` — Unknown format value.

---

#### `insertContentAt`

Insert content at a specific position or range.

**Payload:**

| Field      | Type                                           | Required | Description                                   |
| ---------- | ---------------------------------------------- | -------- | --------------------------------------------- |
| `position` | `number` or `{ "from": number, "to": number }` | Yes      | Where to insert                               |
| `content`  | `object` or `string`                           | Yes      | Content to insert (JSON, HTML, or plain text) |

```json
{
  "type": "command",
  "id": "6",
  "name": "insertContentAt",
  "payload": {
    "position": 5,
    "content": "<strong>inserted</strong>"
  }
}
```

**Response:** `{ "success": true }`

---

### Text Input Commands

#### `insertText`

Insert text at the current selection or a given range. This is the primary command for committed keystrokes from the native input system.

**Payload:**

| Field   | Type                               | Required | Description                                                          |
| ------- | ---------------------------------- | -------- | -------------------------------------------------------------------- |
| `text`  | `string`                           | Yes      | The text to insert                                                   |
| `range` | `{ "from": number, "to": number }` | No       | Optional range to replace. If omitted, inserts at current selection. |

```json
{
  "type": "command",
  "id": "7",
  "name": "insertText",
  "payload": { "text": "Hello" }
}
```

With a range (e.g., after IME composition commit):

```json
{
  "type": "command",
  "id": "8",
  "name": "insertText",
  "payload": {
    "text": "replaced",
    "range": { "from": 1, "to": 6 }
  }
}
```

**Response:** `{ "success": true }`

---

#### `deleteRange`

Delete content in a range or at the cursor (backspace behavior).

**Payload:**

| Field   | Type                               | Required | Description                                                |
| ------- | ---------------------------------- | -------- | ---------------------------------------------------------- |
| `range` | `{ "from": number, "to": number }` | No       | Range to delete. If omitted, performs backspace at cursor. |

Backspace (no range):

```json
{ "type": "command", "id": "9", "name": "deleteRange", "payload": {} }
```

Explicit range:

```json
{
  "type": "command",
  "id": "10",
  "name": "deleteRange",
  "payload": { "range": { "from": 5, "to": 10 } }
}
```

**Response:** `{ "success": true }`

---

### Generic Execution

#### `exec`

Execute any Tiptap command by name. This is the gateway for all formatting, structural, and utility commands. The engine calls `editor.chain().focus()[commandName](args).run()`.

**Payload:**

| Field     | Type     | Required | Description                      |
| --------- | -------- | -------- | -------------------------------- |
| `command` | `string` | Yes      | The Tiptap command name          |
| `args`    | `object` | No       | Arguments to pass to the command |

Toggle bold (no args):

```json
{
  "type": "command",
  "id": "11",
  "name": "exec",
  "payload": { "command": "toggleBold" }
}
```

Set heading level (with args):

```json
{
  "type": "command",
  "id": "12",
  "name": "exec",
  "payload": { "command": "setHeading", "args": { "level": 2 } }
}
```

Insert a table:

```json
{
  "type": "command",
  "id": "13",
  "name": "exec",
  "payload": {
    "command": "insertTable",
    "args": { "rows": 3, "cols": 3, "withHeaderRow": true }
  }
}
```

**Response:**

```json
{ "success": true, "payload": { "executed": true } }
```

**Errors:**

- `UNKNOWN_EXEC_COMMAND` — The command name is not available on the editor.

See [Command Names for exec](#command-names-for-exec) for the full list.

---

### Selection Commands

#### `setTextSelection`

Set a cursor or text range selection.

**Payload:**

| Field    | Type     | Required | Description                                            |
| -------- | -------- | -------- | ------------------------------------------------------ |
| `anchor` | `number` | Yes      | The fixed side of the selection                        |
| `head`   | `number` | No       | The moving side. If omitted, equals `anchor` (cursor). |

Cursor at position 5:

```json
{
  "type": "command",
  "id": "14",
  "name": "setTextSelection",
  "payload": { "anchor": 5 }
}
```

Range selection from 1 to 10:

```json
{
  "type": "command",
  "id": "15",
  "name": "setTextSelection",
  "payload": { "anchor": 1, "head": 10 }
}
```

**Response:** `{ "success": true }`

---

#### `setNodeSelection`

Select an entire node at a position (e.g., an image or horizontal rule).

**Payload:**

| Field      | Type     | Required | Description                    |
| ---------- | -------- | -------- | ------------------------------ |
| `position` | `number` | Yes      | Position of the node to select |

```json
{
  "type": "command",
  "id": "16",
  "name": "setNodeSelection",
  "payload": { "position": 5 }
}
```

**Response:** `{ "success": true }`

---

#### `selectAll`

Select the entire document.

**Payload:** None.

```json
{ "type": "command", "id": "17", "name": "selectAll", "payload": {} }
```

**Response:** `{ "success": true }`

---

#### `focus`

Set logical focus on the editor.

**Payload:**

| Field      | Type                                        | Required | Default          | Description                        |
| ---------- | ------------------------------------------- | -------- | ---------------- | ---------------------------------- |
| `position` | `"start"` or `"end"` or `"all"` or `number` | No       | Current position | Where to place the cursor on focus |

```json
{
  "type": "command",
  "id": "18",
  "name": "focus",
  "payload": { "position": "end" }
}
```

**Response:** `{ "success": true }`

---

#### `blur`

Remove logical focus from the editor.

**Payload:** None.

```json
{ "type": "command", "id": "19", "name": "blur", "payload": {} }
```

**Response:** `{ "success": true }`

---

### Query Commands

#### `getState`

Request a full state snapshot. Returns the same payload shape as the `stateChanged` event.

**Payload:** None.

```json
{ "type": "command", "id": "20", "name": "getState", "payload": {} }
```

**Response:**

```json
{
  "success": true,
  "payload": {
    "doc": { "type": "doc", "pos": 0, "end": 16, "content": [...] },
    "selection": { "type": "text", "anchor": 1, "head": 1, "from": 1, "to": 1, "empty": true },
    "activeMarks": [],
    "activeNodes": [{ "type": "paragraph", "attrs": {} }],
    "commandStates": { "toggleBold": { "canExec": true, "isActive": false }, ... },
    "decorations": [],
    "storedMarks": [],
    "editable": true
  }
}
```

---

#### `isActive`

Check if a mark or node type is active at the current selection.

**Payload:**

| Field   | Type     | Required | Description                                              |
| ------- | -------- | -------- | -------------------------------------------------------- |
| `name`  | `string` | Yes      | Mark or node type name                                   |
| `attrs` | `object` | No       | Attributes to match (e.g., `{ "level": 2 }` for heading) |

```json
{
  "type": "command",
  "id": "21",
  "name": "isActive",
  "payload": { "name": "bold" }
}
```

With attribute matching:

```json
{
  "type": "command",
  "id": "22",
  "name": "isActive",
  "payload": { "name": "heading", "attrs": { "level": 1 } }
}
```

**Response:**

```json
{ "success": true, "payload": { "active": true } }
```

---

#### `canExec`

Check if a command can execute in the current state.

**Payload:**

| Field     | Type     | Required | Description                      |
| --------- | -------- | -------- | -------------------------------- |
| `command` | `string` | Yes      | The command name to check        |
| `args`    | `object` | No       | Optional arguments for the check |

```json
{
  "type": "command",
  "id": "23",
  "name": "canExec",
  "payload": { "command": "toggleBold" }
}
```

**Response:**

```json
{ "success": true, "payload": { "canExec": true } }
```

---

#### `getAttributes`

Get attributes of a mark or node type at the current selection.

**Payload:**

| Field  | Type     | Required | Description            |
| ------ | -------- | -------- | ---------------------- |
| `name` | `string` | Yes      | Mark or node type name |

```json
{
  "type": "command",
  "id": "24",
  "name": "getAttributes",
  "payload": { "name": "heading" }
}
```

**Response:**

```json
{ "success": true, "payload": { "attrs": { "level": 2 } } }
```

---

## Events

### `schemaReady`

Emitted once after `init`, before `ready`. Contains the full schema introspection payload.

```json
{
  "type": "event",
  "name": "schemaReady",
  "payload": {
    "nodes": [
      {
        "name": "paragraph",
        "contentExpression": "inline*",
        "group": "block",
        "attrs": [{ "name": "textAlign", "default": null }],
        "isLeaf": false,
        "isInline": false,
        "isBlock": true
      }
    ],
    "marks": [
      {
        "name": "bold",
        "attrs": []
      },
      {
        "name": "link",
        "attrs": [
          { "name": "href", "default": null },
          { "name": "target", "default": null }
        ]
      }
    ],
    "commands": [
      {
        "name": "toggleBold",
        "type": "toggle-mark",
        "associatedType": "bold",
        "args": [],
        "group": "formatting",
        "extensionName": "bold"
      },
      {
        "name": "setHeading",
        "type": "set-node",
        "associatedType": "heading",
        "args": [{ "name": "level", "required": true }],
        "group": "blocks",
        "extensionName": "heading"
      }
    ]
  }
}
```

Command types in the `commands` array:

| Type          | Meaning                                   | UI Hint         |
| ------------- | ----------------------------------------- | --------------- |
| `toggle-mark` | Toggles an inline mark on/off             | Toggle button   |
| `toggle-node` | Toggles a block node type                 | Toggle button   |
| `set-node`    | Sets a block node type (no toggle)        | Dropdown option |
| `wrap`        | Wraps selection in a node                 | Button          |
| `lift`        | Lifts content out of a wrapping node      | Button          |
| `action`      | One-shot action (undo, insertTable, etc.) | Button          |

### `ready`

Emitted once after `init`, after `schemaReady`. Signals the engine is ready for commands.

```json
{ "type": "event", "name": "ready", "payload": {} }
```

### `stateChanged`

Emitted after every transaction. The primary event ports use to re-render. Contains the complete editor state.

```json
{
  "type": "event",
  "name": "stateChanged",
  "payload": {
    "doc": {
      "type": "doc",
      "pos": 0,
      "end": 16,
      "content": [
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
            },
            { "type": "text", "pos": 13, "end": 14, "text": "!" }
          ]
        }
      ]
    },
    "selection": {
      "type": "text",
      "anchor": 5,
      "head": 5,
      "from": 5,
      "to": 5,
      "empty": true
    },
    "activeMarks": [],
    "activeNodes": [{ "type": "paragraph", "attrs": {} }],
    "commandStates": {
      "toggleBold": { "canExec": true, "isActive": false },
      "undo": { "canExec": true, "isActive": false, "depth": 3 },
      "redo": { "canExec": false, "isActive": false, "depth": 0 }
    },
    "decorations": [],
    "storedMarks": [],
    "editable": true
  }
}
```

### `contentChanged`

Emitted only when the document content changes (not on selection-only changes). Useful for debounced auto-save.

```json
{
  "type": "event",
  "name": "contentChanged",
  "payload": {
    "doc": { "type": "doc", "pos": 0, "end": 16, "content": [...] }
  }
}
```

### `selectionChanged`

Emitted on selection-only changes (no document mutation). Lighter than `stateChanged` — omits the document tree.

```json
{
  "type": "event",
  "name": "selectionChanged",
  "payload": {
    "selection": { "type": "text", "anchor": 5, "head": 5, "from": 5, "to": 5, "empty": true },
    "activeMarks": ["bold"],
    "activeNodes": [{ "type": "paragraph", "attrs": {} }],
    "commandStates": { ... }
  }
}
```

### `error`

Emitted when an error occurs in the engine.

```json
{
  "type": "event",
  "name": "error",
  "payload": {
    "code": "COMMAND_FAILED",
    "message": "Something went wrong",
    "commandId": "42"
  }
}
```

`commandId` is present when the error was caused by a specific command.

### `extensionEvent`

Generic passthrough for extension-specific events. The engine does not interpret these.

```json
{
  "type": "event",
  "name": "extensionEvent",
  "payload": {
    "extensionName": "mention",
    "eventName": "suggestionQuery",
    "data": { "query": "@john" }
  }
}
```

---

## Responses

Every command gets exactly one response with the matching `id`.

### Success (no payload)

Most mutation commands return a bare success:

```json
{ "type": "response", "id": "1", "success": true }
```

### Success (with payload)

Query commands include their result:

```json
{
  "type": "response",
  "id": "5",
  "success": true,
  "payload": { "content": "<p>Hello</p>" }
}
```

### Error

```json
{
  "type": "response",
  "id": "99",
  "success": false,
  "error": {
    "code": "NOT_INITIALIZED",
    "message": "Engine is not initialized. Send an init command first."
  }
}
```

### Error Codes

| Code                   | Meaning                                                  |
| ---------------------- | -------------------------------------------------------- |
| `NOT_INITIALIZED`      | Command sent before `init` or after `destroy`            |
| `ALREADY_INITIALIZED`  | `init` sent when the engine is already running           |
| `UNKNOWN_COMMAND`      | Unrecognized command name                                |
| `UNKNOWN_EXEC_COMMAND` | The command passed to `exec` doesn't exist on the editor |
| `INVALID_FORMAT`       | Unknown format in `getContent`                           |
| `COMMAND_FAILED`       | The command threw an exception during execution          |

---

## Data Types

### AnnotatedNode

Every node in the document JSON carries position annotations.

```json
{
  "type": "paragraph",
  "pos": 1,
  "end": 15,
  "attrs": { "textAlign": "center" },
  "content": [ ... ],
  "marks": [{ "type": "bold", "attrs": {} }],
  "text": "Hello"
}
```

| Field     | Type              | Present                           | Description                                           |
| --------- | ----------------- | --------------------------------- | ----------------------------------------------------- |
| `type`    | `string`          | Always                            | Node type name                                        |
| `pos`     | `number`          | Always                            | ProseMirror position where this node's content starts |
| `end`     | `number`          | Always                            | ProseMirror position where this node ends             |
| `attrs`   | `object`          | When non-default attributes exist | Node attributes                                       |
| `content` | `AnnotatedNode[]` | On nodes with children            | Child nodes                                           |
| `marks`   | `Mark[]`          | On text nodes with marks          | Applied marks                                         |
| `text`    | `string`          | On text nodes                     | Text content                                          |

Position rules:

- For block nodes: `pos` is after the opening token, `end` is after the closing token
- For text nodes: `pos` is the first character, `end - pos` equals the text length
- The document node starts at `pos: 0`
- A child's `pos` equals its parent's `pos + 1` (for the first child of a block node)

### SelectionState

```json
{
  "type": "text",
  "anchor": 5,
  "head": 10,
  "from": 5,
  "to": 10,
  "empty": false
}
```

| Field    | Type                                             | Description                                    |
| -------- | ------------------------------------------------ | ---------------------------------------------- |
| `type`   | `"text"` or `"node"` or `"all"` or `"gapcursor"` | Selection kind                                 |
| `anchor` | `number`                                         | Fixed side of the selection                    |
| `head`   | `number`                                         | Moving side of the selection                   |
| `from`   | `number`                                         | Start of selection range (min of anchor, head) |
| `to`     | `number`                                         | End of selection range (max of anchor, head)   |
| `empty`  | `boolean`                                        | True when from equals to (cursor, no range)    |

### CommandState

```json
{ "canExec": true, "isActive": false, "depth": 3 }
```

| Field      | Type                | Description                                                 |
| ---------- | ------------------- | ----------------------------------------------------------- |
| `canExec`  | `boolean`           | Whether the command can execute in the current state        |
| `isActive` | `boolean`           | Whether the associated mark/node is active at the selection |
| `depth`    | `number` (optional) | Stack depth for undo/redo only                              |

### Mark

```json
{ "type": "bold" }
```

```json
{
  "type": "link",
  "attrs": { "href": "https://example.com", "target": "_blank" }
}
```

| Field   | Type     | Present                           | Description     |
| ------- | -------- | --------------------------------- | --------------- |
| `type`  | `string` | Always                            | Mark type name  |
| `attrs` | `object` | When non-default attributes exist | Mark attributes |

### ActiveNode

```json
{ "type": "heading", "attrs": { "level": 2 } }
```

Represents a node type active at the current selection, with its attributes.

---

## Command Names for exec

These are the most commonly used commands available through the `exec` command. The full list depends on which extensions are loaded (the `schemaReady` event reports all available commands).

### Formatting

| Command             | Args                | Description          |
| ------------------- | ------------------- | -------------------- |
| `toggleBold`        | —                   | Toggle bold mark     |
| `toggleItalic`      | —                   | Toggle italic mark   |
| `toggleStrike`      | —                   | Toggle strikethrough |
| `toggleCode`        | —                   | Toggle inline code   |
| `toggleUnderline`   | —                   | Toggle underline     |
| `toggleHighlight`   | `{ color? }`        | Toggle highlight     |
| `toggleSuperscript` | —                   | Toggle superscript   |
| `toggleSubscript`   | —                   | Toggle subscript     |
| `setLink`           | `{ href, target? }` | Apply link mark      |
| `unsetLink`         | —                   | Remove link mark     |
| `setColor`          | `{ color }`         | Set text color       |
| `unsetColor`        | —                   | Remove text color    |

### Block Types

| Command            | Args            | Description                |
| ------------------ | --------------- | -------------------------- |
| `setParagraph`     | —               | Convert to paragraph       |
| `toggleHeading`    | `{ level }`     | Toggle heading (level 1-6) |
| `setHeading`       | `{ level }`     | Set heading without toggle |
| `toggleCodeBlock`  | `{ language? }` | Toggle code block          |
| `toggleBlockquote` | —               | Toggle blockquote wrapping |

### Lists

| Command             | Args | Description         |
| ------------------- | ---- | ------------------- |
| `toggleBulletList`  | —    | Toggle bullet list  |
| `toggleOrderedList` | —    | Toggle ordered list |
| `toggleTaskList`    | —    | Toggle task list    |
| `sinkListItem`      | —    | Indent list item    |
| `liftListItem`      | —    | Outdent list item   |

### Tables

| Command              | Args                               | Description               |
| -------------------- | ---------------------------------- | ------------------------- |
| `insertTable`        | `{ rows?, cols?, withHeaderRow? }` | Insert a table            |
| `deleteTable`        | —                                  | Delete the current table  |
| `addColumnBefore`    | —                                  | Add column before current |
| `addColumnAfter`     | —                                  | Add column after current  |
| `deleteColumn`       | —                                  | Delete current column     |
| `addRowBefore`       | —                                  | Add row before current    |
| `addRowAfter`        | —                                  | Add row after current     |
| `deleteRow`          | —                                  | Delete current row        |
| `mergeCells`         | —                                  | Merge selected cells      |
| `splitCell`          | —                                  | Split a merged cell       |
| `toggleHeaderRow`    | —                                  | Toggle header row         |
| `toggleHeaderColumn` | —                                  | Toggle header column      |

### Insert

| Command             | Args                    | Description                     |
| ------------------- | ----------------------- | ------------------------------- |
| `setHorizontalRule` | —                       | Insert horizontal rule          |
| `setHardBreak`      | —                       | Insert hard break (shift+enter) |
| `setImage`          | `{ src, alt?, title? }` | Insert image                    |

### Alignment

| Command          | Args            | Description                                               |
| ---------------- | --------------- | --------------------------------------------------------- |
| `setTextAlign`   | `{ alignment }` | Set text alignment ("left", "center", "right", "justify") |
| `unsetTextAlign` | —               | Remove text alignment                                     |

### History

| Command | Args | Description             |
| ------- | ---- | ----------------------- |
| `undo`  | —    | Undo last change        |
| `redo`  | —    | Redo last undone change |

### Selection

| Command     | Args            | Description            |
| ----------- | --------------- | ---------------------- |
| `selectAll` | —               | Select entire document |
| `focus`     | `{ position? }` | Focus the editor       |
| `blur`      | —               | Blur the editor        |
