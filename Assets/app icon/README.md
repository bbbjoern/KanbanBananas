# Handoff: KanbanBananas extension icon

## Overview
Final icon (option **3c**, "Peeled on dark") for **KanbanBananas**, a VS Code extension that provides a Kanban board for coding projects. The mark is a banana whose peel splits into three strips; each strip is a Kanban column holding cards, and one card is shown being dragged from column 1 into column 2.

## About the files
`icon.svg`, `icon.png` and `activitybar-icon.svg` are **final production assets**. Wire them into the extension as they are. Don't redraw them.
`reference/` holds the HTML design exploration (every option considered). It's for context only and isn't part of the extension. Open `reference/KanbanBananas Icon.dc.html` in a browser; option 3c is at the top.

## Fidelity
High-fidelity. Colors and geometry are final.

## Assets
| File | Use |
|---|---|
| `icon.png` (128×128) | Marketplace / Extensions view icon: `"icon"` in package.json. **Must be PNG**; the Marketplace rejects SVG for this field. |
| `icon-2x.png` (256×256) | Hi-res copy for README, website, social. Not referenced by package.json. |
| `icon.svg` | Master vector source for the full-color icon. |
| `activitybar-icon.svg` (24×24, monochrome) | Activity Bar view container icon. VS Code uses the SVG as a mask and tints it to the theme, so it's a single-color silhouette: peel strips + stem, with cards knocked out and the dragged card solid. |
| `preview/activitybar-preview.png` | How the mono icon looks tinted (#CCCCCC). Reference only. |

## Implementation (package.json)
Copy the assets into the extension, e.g. `media/`, then:

```jsonc
{
  "icon": "media/icon.png",
  "galleryBanner": { "color": "#2A2620", "theme": "dark" },
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        { "id": "kanbanBananas", "title": "KanbanBananas", "icon": "media/activitybar-icon.svg" }
      ]
    },
    "views": {
      "kanbanBananas": [
        { "id": "kanbanBananas.board", "name": "Board", "type": "webview" }
      ]
    }
  }
}
```
Adjust the view id and type to match the extension's real architecture. Add `media/` to the package if `.vscodeignore` excludes it, and make sure `reference/` and `preview/` are **not** shipped in the .vsix.

For webview panel tabs (`WebviewPanel.iconPath`) you can use `icon.png`, or `{ light, dark }` URIs pointing at the mono SVG with a fixed fill.

## Design tokens
- Tile / cards: `#2A2620` (warm near-black)
- Banana yellow: `#F5CF2E`
- Stem green: `#6F9A3A`
- Tile corner radius: 28 / 128 (≈22%)

## Geometry (128×128 viewBox)
- Tile: 0,0 128×128, rx 28
- Peel crossbar: x16 y20 96×16, rx 8
- Strips (rx 12): x16 w30 h94 · x49 w30 h80 · x82 w30 h66 (all y20; stepping shorter left→right)
- Stem: x55 y4 18×20, rx 5
- Cards 20×14, rx 4: (21,40) (21,58) · (54,40) (54,58) · (87,40)
- Dragged card: x36 y78 24×17, rx 4, 3px #F5CF2E stroke, rotated −12° about (48,86)

## Files
- `icon.svg`, `icon.png`, `icon-2x.png`, `activitybar-icon.svg`
- `preview/activitybar-preview.png`
- `reference/KanbanBananas Icon.dc.html` (+ `support.js` runtime)
