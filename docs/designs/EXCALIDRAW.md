# Excalidraw Wireframing Setup

## Quick Start

Install the VS Code extension:

```bash
code --install-extension pomdtr.excalidraw-editor
```

Then just open any `.excalidraw` file in VS Code — it renders in the full Excalidraw editor. Cmd+S saves in place.
**BEWARE:** Changes made by the agent don't appear until you reopen the file.

## Workflow

1. Claude generates a `.excalidraw` file in the appropriate milestone's directory.
2. Open it in VS Code (double-click or `code filename.excalidraw`)
3. Edit visually, Cmd+S saves directly back to the file
4. Ask Claude to tweak it — Claude reads the JSON and writes updates
5. Export to SVG/PNG from the Excalidraw editor for sharing (hamburger menu → Export image)

## File Format

`.excalidraw` files are JSON. The structure:

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "https://excalidraw.com",
  "elements": [
    {
      "id": "unique-id",
      "type": "rectangle", // rectangle, ellipse, diamond, text, line, arrow, freedraw
      "x": 100,
      "y": 100, // position (top-left origin, x right, y down)
      "width": 200,
      "height": 80,
      "strokeColor": "#1e1e1e",
      "backgroundColor": "#a5d8ff",
      "fillStyle": "solid", // solid, hashed, cross-hatch, dots
      "strokeWidth": 2,
      "roughness": 1, // 0=architect, 1=artist, 2=cartoonist
      "roundness": { "type": 3 }, // null=sharp, type 3=rounded
      "text": "Label", // for type=text only
      "fontSize": 20,
      "fontFamily": 1, // 1=Virgil(hand), 2=Helvetica, 3=Cascadia(code)
      "angle": 0,
      "seed": 12345, // random seed for hand-drawn look
      "groupIds": [],
      "boundElements": [], // links to arrows/text bound to this element
      "isDeleted": false
    }
  ],
  "appState": {
    "gridSize": null,
    "viewBackgroundColor": "#ffffff"
  },
  "files": {}
}
```

### Element types for wireframes

- **rectangle** — boxes, containers, buttons, input fields
- **text** — labels, titles, field values
- **line** — dividers, connections (set `points` array for multi-segment)
- **arrow** — flow arrows (set `startBinding`/`endBinding` to connect to elements)
- **ellipse** — icons, status indicators
- **diamond** — decision points

### Binding text to shapes

To put a label inside a rectangle:

1. Create the rectangle with a `boundElements` entry: `[{"id": "text-id", "type": "text"}]`
2. Create a text element with `"containerId": "rectangle-id"` and matching id

### Grouping

Set the same group ID in `groupIds` array on multiple elements to group them.

### Colors for wireframes

Use a limited palette for clarity:

- `#1e1e1e` — default stroke (near-black)
- `#a5d8ff` — light blue fill (interactive elements, buttons)
- `#fff3cd` — yellow fill (proposed/warning state)
- `#d4edda` — green fill (accepted/success state)
- `#f8d7da` — red fill (error/deleted state)
- `#e9ecef` — gray fill (disabled/background)
- `#ffffff` — white fill (content areas)

## File Organization

Keep `.excalidraw` files alongside the docs they belong to. For example, M1 wireframes go in the M1 folder. Exports (SVG/PNG) go right next to the source file.
