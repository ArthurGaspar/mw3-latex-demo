# LaTeX Studio

https://arthurgaspar.github.io/mw3-latex-demo/

An in-browser LaTeX editor that compiles **entirely on the client**. pdfTeX runs as
WebAssembly in a Web Worker, a trimmed TeX Live tree is served as static files, and the
result is shown in an embedded pdf.js viewer. No backend, no accounts, no upload. Your
documents never leave the browser.

<!-- Add a screenshot: docs/screenshot.png -->

## Features

- **Real pdfTeX, locally.** It's the SwiftLaTeX WebAssembly build of pdfTeX with a preloaded
  LaTeX format, so compiles take seconds and work offline once the files are cached.
- **Editor ↔ PDF scroll sync.** Scroll either pane and the other follows. Sync anchors come
  from the section headings: the PDF outline when `hyperref` is loaded, and otherwise
  text search for headings set larger than body text. Zoom and rotation survive a recompile.
- **Toolbar that writes LaTeX for you:** bold/italic toggles (they unwrap as well as wrap),
  `\href` with URL escaping, headings, nesting-aware `itemize`/`enumerate`, alignment
  environments, and `tcolorbox` content boxes.
- **Templates:** blank, lecture notes (the content boxes, theorem environments, a themed title)
  and article.
- **Find bar** (Ctrl+F) that highlights every match, with current/total counts.
- **Local documents.** Several documents are kept in `localStorage`. Templates open as unsaved
  drafts, and switching away from a saved document saves it.
- **Light/dark themes**, and a **English/Portuguese** UI toggle.
- **Resilient engine handling.** A WebAssembly abort kills the worker without ever settling
  the compile promise. The app races compilation against `worker.onerror` and replaces a dead
  engine, so it never reuses one that would hang every later compile.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| Ctrl/Cmd + Enter | Compile |
| Ctrl/Cmd + S | Save document |
| Ctrl/Cmd + F | Find in source |
| Ctrl/Cmd + B / I | Toggle `\textbf` / `\textit` |
| Esc | Close find bar / leave focus mode |

## Running locally

The app is plain HTML/CSS/JS, so there's no build step. It must be served over HTTP (Web
Workers and `fetch` don't work from `file://`):

```sh
node dev-server.js
# → http://localhost:8321
```

Any static server works, **as long as it serves `.mjs` as JavaScript** (the pdf.js viewer
needs it) and `.wasm` as `application/wasm`.

## Deploying

The whole thing is static, so GitHub Pages, Cloudflare Pages and Netlify all work. Push the
repository and point the host at the root. The `.nojekyll` file stops GitHub Pages from
running Jekyll over the TeX tree.

## How it works

```
index.html
 ├─ js/studio.js ── CodeMirror 5 (stex mode)
 │     │
 │     ├─ compile ─► tex/engine/PdfTeXEngine.js ─► Web Worker: swiftlatexpdftex.{js,wasm}
 │     │                                               │  kpathsea lookups become
 │     │                                               ▼  fetch() calls into
 │     │                                          tex/texlive/pdftex/<bucket>/<file>
 │     │
 │     └─ PDF bytes ─► Blob URL ─► <iframe> tex/pdfjs/web/viewer.html
 │                                     └─ outline / text layer ─► scroll-sync anchors
 └─ js/i18n.js ── EN/PT dictionary
```

The TeX tree under `tex/texlive/pdftex/` is split into numbered buckets by file type, which
is the layout the engine's file loader expects:

| Bucket | Contents |
|---|---|
| `3` | Font metrics (`.tfm`) |
| `10` | Precompiled format (`swiftlatexpdftex.fmt`) |
| `11` | Font map (`pdftex.map`) |
| `26` | Classes, packages and support files (`.cls`, `.sty`, `.def`, `.fd`, …) |
| `32` | Type 1 fonts (`.pfb`) |
| `44` | Font encodings (`.enc`) |

## Adding LaTeX packages

The tree is trimmed: it holds what the bundled templates need, plus common packages
(amsmath, tcolorbox/pgf, hyperref, enumitem, booktabs, geometry, babel, tipa, listings…).
To add more:

1. Add the CTAN package names to `tex/fetch-texlive.py` and run it. It downloads from a
   TeX Live mirror, unpacks into the right buckets and regenerates `pdftex.map`.
2. If you changed core macro files, rebuild the format: run `node dev-server.js` and open
   `http://localhost:8321/tex/compile-format.html`. The new `.fmt` is saved in place.

`tex/sync-packages.py` re-copies everything from `tex/texlive-packages/` into the buckets,
which helps after editing package sources by hand.

## Limitations

- pdfTeX only: no XeTeX/LuaTeX, so no `fontspec` or system fonts.
- Unicode beyond Latin-1 needs `\DeclareUnicodeCharacter` mappings.
- Documents live in one browser's `localStorage`. Clearing site data deletes them.
- Each compile is a single pass. Cross-references and `hyperref` bookmarks settle on the
  second compile, because the `.aux` file persists in the worker between runs.

## Project layout

```
index.html            page markup
css/studio.css        all styles (theme tokens at the top)
js/i18n.js            EN/PT strings
js/studio.js          editor, compile, viewer, scroll sync, toolbar
templates/{en,pt}/    .tex templates ({{title}} is substituted on creation)
tex/engine/           pdfTeX WebAssembly engine + JS wrapper
tex/texlive/          trimmed TeX Live tree
tex/pdfjs/            pdf.js viewer
tex/*.py, compile-format.html   tooling for the TeX tree (not loaded by the app)
dev-server.js         local static server
```

## Third-party software

| Component | License |
|---|---|
| [SwiftLaTeX](https://github.com/SwiftLaTeX/SwiftLaTeX) pdfTeX WebAssembly engine | AGPL-3.0 (JS wrapper: EPL-2.0 / GPL-2.0 with Classpath exception) |
| [pdf.js](https://github.com/mozilla/pdf.js) | Apache-2.0 (`tex/pdfjs/LICENSE`) |
| [CodeMirror 5](https://codemirror.net/5/) (loaded from cdnjs) | MIT |
| TeX Live packages under `tex/texlive/` | Each package's own license (LPPL, GPL, OFL, …) |
