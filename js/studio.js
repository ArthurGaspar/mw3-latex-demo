(function () {
    'use strict';

    const { t, onChange: onLangChange } = window.Studio.i18n;

    const DOCS_KEY   = 'latex-studio:docs';
    const ACTIVE_KEY = 'latex-studio:active';
    const SYNC_KEY   = 'latex-studio:sync-scroll';
    const THEME_KEY  = 'latex-studio:theme';

    // `label` and `title` are i18n keys; the .tex body comes from templates/<lang>/<id>.tex.
    const TEMPLATES = [
        { id: 'blank',         label: 'Blank',         title: 'New Document' },
        { id: 'lecture-notes', label: 'Lecture notes', title: 'New Lecture Notes' },
        { id: 'article',       label: 'Article',       title: 'New Article' },
    ];
    const FIRST_RUN_TEMPLATE = 'lecture-notes';

    let editor        = null;
    let engine        = null;
    let engineReady   = false;
    let engineLoading = false;
    let currentDocId  = null;
    let currentPdfUrl = null;
    let viewerApp     = null;   // PDFViewerApplication inside the viewer iframe
    let viewerReady   = null;   // promise resolving once the viewer is initialized
    let syncScroll    = true;
    let activePane    = 'editor'; // 'editor' | 'pdf'
    let syncAnchors   = null;     // [{line, page, frac}] source <=> PDF anchors, rebuilt on compile
    let syncMuted     = false;    // true while a PDF reload resets/restores scroll
    let lastStatus    = null;     // { key, type, vars } so a language switch can re-render it

    // ── Storage ───────────────────────────────────────────────────
    function getDocs() {
        try { return JSON.parse(localStorage.getItem(DOCS_KEY)) || []; }
        catch { return []; }
    }
    function saveDocs(docs) { localStorage.setItem(DOCS_KEY, JSON.stringify(docs)); }
    function getActiveId()  { try { return localStorage.getItem(ACTIVE_KEY); } catch { return null; } }
    function setActiveId(id){ try { localStorage.setItem(ACTIVE_KEY, id); } catch {} }

    // ── Engine ────────────────────────────────────────────────────
    async function ensureEngine() {
        if (engineReady) return true;
        if (engineLoading) return false;
        engineLoading = true;
        setStatus('Loading engine (~2 MB)…', 'loading');
        try {
            engine = new window.PdfTeXEngine();
            await engine.loadEngine();
            engineReady = true;
            engineLoading = false;
            setStatus('Engine ready', 'ok');
            return true;
        } catch (e) {
            resetEngine();
            setStatus('Engine failed to load', 'error');
            console.error('[latex-studio] engine load failed:', e);
            return false;
        }
    }

    // A wasm abort kills the worker without ever settling compileLaTeX(),
    // so a dead engine must be discarded or every later compile hangs.
    function resetEngine() {
        try { engine?.latexWorker?.terminate(); } catch {}
        engine = null;
        engineReady = false;
        engineLoading = false;
    }

    // ── UI helpers ────────────────────────────────────────────────
    function setStatus(key, type, vars) {
        lastStatus = { key, type, vars };
        renderStatus();
    }

    function renderStatus() {
        const el = document.getElementById('latex-status');
        if (!el || !lastStatus) return;
        el.textContent = lastStatus.key ? t(lastStatus.key, lastStatus.vars) : '';
        el.className = 'latex-status' + (lastStatus.type ? ' latex-status-' + lastStatus.type : '');
    }

    function showPlaceholder(visible) {
        const ph = document.getElementById('latex-placeholder');
        if (ph) ph.style.display = visible ? 'flex' : 'none';
    }

    function showLog(log) {
        const logEl = document.getElementById('latex-log');
        const frame = document.getElementById('latex-pdf-frame');
        if (frame) frame.style.display = 'none';
        if (logEl) { logEl.textContent = log; logEl.style.display = 'block'; }
        showPlaceholder(false);
    }

    function showPdfFrame() {
        const logEl = document.getElementById('latex-log');
        const frame = document.getElementById('latex-pdf-frame');
        if (logEl) logEl.style.display = 'none';
        if (frame) frame.style.display = 'block';
        showPlaceholder(false);
    }

    function clearPreview() {
        const logEl = document.getElementById('latex-log');
        const frame = document.getElementById('latex-pdf-frame');
        if (logEl) { logEl.style.display = 'none'; logEl.textContent = ''; }
        if (frame) frame.style.display = 'none';
        if (viewerApp?.pdfDocument) viewerApp.close().catch(() => {});
        syncAnchors = null;
        if (currentPdfUrl) { URL.revokeObjectURL(currentPdfUrl); currentPdfUrl = null; }
        showPlaceholder(true);
    }

    // ── PDF preview (embedded pdf.js viewer) ──────────────────────

    // Loads the viewer on first use; resolves with PDFViewerApplication.
    function ensureViewer() {
        if (viewerReady) return viewerReady;
        const frame = document.getElementById('latex-pdf-frame');
        viewerReady = new Promise((resolve, reject) => {
            frame.addEventListener('load', async () => {
                try {
                    const app = frame.contentWindow.PDFViewerApplication;
                    await app.initializedPromise;
                    wireViewerSync(app);
                    viewerApp = app;
                    resolve(app);
                } catch (e) {
                    viewerReady = null;
                    reject(e);
                }
            }, { once: true });
            frame.src = 'tex/pdfjs/web/viewer.html?file=';
        });
        return viewerReady;
    }

    // PDF --> editor half of the sync (editor --> PDF lives in init()).
    function wireViewerSync(app) {
        const cont = app.pdfViewer.container;
        cont.addEventListener('mouseenter', () => activePane = 'pdf');
        cont.addEventListener('scroll', () => {
            if (syncMuted || !syncScroll || activePane !== 'pdf' || !editor) return;
            const px = computeSyncPixels(app);
            if (!px) return;
            editor.scrollTo(null, mapSync(cont.scrollTop, px.pdf, px.ed));
        });
    }

    // ── Anchor-based sync mapping ─────────────────────────────────

    // Diacritics and punctuation are dropped because pdftex with OT1
    // fonts extracts accented glyphs as base char + stray accent marks.
    function normalizeHeading(s) {
        return s.replace(/\\[a-zA-Z@]+\*?/g, ' ')
                .normalize('NFD')
                .replace(/[^a-zA-Z0-9]/g, '')
                .toLowerCase();
    }

    function pageFrac(app, page, yTop) {
        const vb = app.pdfViewer.getPageView(page)?.viewport?.viewBox;
        if (!vb || typeof yTop !== 'number') return 0;
        return Math.min(1, Math.max(0, (vb[3] - yTop) / (vb[3] - vb[1])));
    }

    async function outlineAnchors(app, doc, headings) {
        const flat = [];
        (function walk(items) {
            if (!items) return;
            for (const it of items) { flat.push(it); walk(it.items); }
        })(await doc.getOutline());
        if (!flat.length) return null;

        const anchors = [];
        let next = 0; // two-pointer keeps anchors monotone in source order
        for (const it of flat) {
            const title = normalizeHeading(it.title || '');
            if (!title) continue;
            let j = next;
            while (j < headings.length && headings[j].title !== title) j++;
            if (j >= headings.length) continue;

            let dest = it.dest;
            if (typeof dest === 'string') dest = await doc.getDestination(dest);
            if (!Array.isArray(dest) || !dest[0]) continue;
            const page = await doc.getPageIndex(dest[0]);
            anchors.push({ line: headings[j].line, page, frac: pageFrac(app, page, dest[3]) });
            next = j + 1;
        }
        return anchors.length ? anchors : null;
    }

    // No outline: find each heading in the page text. Only text larger
    // than the dominant body size is considered, so TOC entries (body
    // size) can't shadow the real headings.
    async function textAnchors(app, doc, headings) {
        const pages = Math.min(doc.numPages, 150);
        const contents = [];
        for (let p = 0; p < pages; p++) {
            contents.push(await (await doc.getPage(p + 1)).getTextContent());
        }

        const freq = new Map();
        for (const tc of contents) {
            for (const it of tc.items) {
                if (!it.str || !it.str.trim()) continue;
                const h = Math.round(it.height);
                freq.set(h, (freq.get(h) || 0) + it.str.length);
            }
        }
        let bodyH = 0, best = 0;
        for (const [h, n] of freq) if (n > best) { best = n; bodyH = h; }
        const minH = bodyH * 1.15;

        const anchors = [];
        let hi = 0;
        for (let p = 0; p < pages && hi < headings.length; p++) {
            const items = contents[p].items.filter(it =>
                it.height > minH && it.str && it.str.trim());
            if (!items.length) continue;

            let str = '';
            const owner = [];
            for (let k = 0; k < items.length; k++) {
                const s = normalizeHeading(items[k].str);
                for (let c = 0; c < s.length; c++) owner.push(k);
                str += s;
            }

            let from = 0;
            // Look a few headings ahead so one failed extraction
            // doesn't block every anchor after it.
            for (let j = hi; j < headings.length && j < hi + 4;) {
                const idx = str.indexOf(headings[j].title, from);
                if (idx < 0) { j++; continue; }
                const it = items[owner[idx]];
                anchors.push({
                    line: headings[j].line,
                    page: p,
                    frac: pageFrac(app, p, it.transform[5] + it.height),
                });
                from = idx + headings[j].title.length;
                hi = j + 1;
                j = hi;
            }
        }
        return anchors.length ? anchors : null;
    }

    async function buildSyncAnchors(app) {
        // Old anchors stay valid while rebuilding (approximate > none).
        const doc = app.pdfDocument;
        if (!editor || !doc) { syncAnchors = null; return; }

        // Any sectioning macro, including custom ones whose name ends in
        // chapter/section/part (e.g. \lecturesection).
        const headRe = /\\[a-zA-Z]*(?:chapter|section|part)\*?\s*(?:\[[^\]]*\])?\s*\{(.+)/;
        const headings = [];
        let beginLine = 0;
        let endLine   = editor.lineCount() - 1;
        let inBody    = false;
        for (let i = 0; i < editor.lineCount(); i++) {
            const text = editor.getLine(i);
            if (/^\s*%/.test(text)) continue;
            if (/^\s*\\begin\{document\}/.test(text)) { beginLine = i; inBody = true; continue; }
            if (/^\s*\\end\{document\}/.test(text))   { endLine = i; continue; }
            if (!inBody) continue; // preamble macro defs are not headings
            const m = text.match(headRe);
            if (!m) continue;
            const title = normalizeHeading(m[1].replace(/\}[^}]*$/, ''));
            if (title.length >= 3) headings.push({ line: i, title });
        }

        const anchors = [{ line: beginLine, page: 0, frac: 0 }];
        try {
            if (headings.length) {
                const found = (await outlineAnchors(app, doc, headings))
                           || (await textAnchors(app, doc, headings));
                if (found) anchors.push(...found);
            }
        } catch (e) {
            console.warn('[latex-studio] heading anchors unavailable:', e);
        }
        anchors.push({ line: endLine, page: doc.numPages, frac: 0 });
        syncAnchors = anchors;
    }

    // Anchors --> pixel pairs in current geometry (zoom-independent: page
    // divs and line heights are measured at scroll time, not cached).
    function computeSyncPixels(app) {
        if (!syncAnchors || syncAnchors.length < 2 || !editor) return null;
        const pv      = app.pdfViewer;
        const cont    = pv.container;
        const info    = editor.getScrollInfo();
        const edMax   = info.height - info.clientHeight;
        const pdfMax  = cont.scrollHeight - cont.clientHeight;
        if (edMax <= 0 || pdfMax <= 0) return null;

        const lastLine = editor.lineCount() - 1;
        const ed = [], pdf = [];
        for (const a of syncAnchors) {
            ed.push(editor.heightAtLine(Math.min(a.line, lastLine), 'local'));
            if (a.page >= pv.pagesCount) {
                pdf.push(cont.scrollHeight);
            } else {
                const div = pv.getPageView(a.page)?.div;
                pdf.push(div ? div.offsetTop + a.frac * div.clientHeight : 0);
            }
        }
        // Final pair maps end-of-scroll to end-of-scroll so both panes
        // bottom out together despite differing viewport heights.
        ed[ed.length - 1]  = Math.min(ed[ed.length - 1], edMax);
        pdf[pdf.length - 1] = pdfMax;

        // Drop any anchor that breaks monotonicity in either axis.
        const med = [ed[0]], mpdf = [pdf[0]];
        for (let i = 1; i < ed.length; i++) {
            if (ed[i] > med[med.length - 1] && pdf[i] > mpdf[mpdf.length - 1]) {
                med.push(ed[i]); mpdf.push(pdf[i]);
            }
        }
        if (med.length < 2) return null;
        return { ed: med, pdf: mpdf };
    }

    function mapSync(pos, src, dst) {
        if (pos <= src[0]) return dst[0];
        for (let i = 1; i < src.length; i++) {
            if (pos <= src[i]) {
                const f = (pos - src[i - 1]) / (src[i] - src[i - 1]);
                return dst[i - 1] + f * (dst[i] - dst[i - 1]);
            }
        }
        return dst[dst.length - 1];
    }

    // ── Command wrapping (bold, italic, headings) ─────────────────
    function bracesBalanced(s) {
        let d = 0;
        for (const ch of s) {
            if (ch === '{') d++;
            else if (ch === '}') { d--; if (d < 0) return false; }
        }
        return d === 0;
    }

    // Wraps the selection in \cmd{}; unwraps when the selection already
    // is (or is the inside of) such a wrapper.
    function toggleWrap(cmd) {
        if (!editor) return;
        const wrap = '\\' + cmd + '{';
        const sel  = editor.getSelection();
        const from = editor.getCursor('from');
        const to   = editor.getCursor('to');

        if (sel.startsWith(wrap) && sel.endsWith('}') &&
            bracesBalanced(sel.slice(wrap.length, -1))) {
            editor.replaceSelection(sel.slice(wrap.length, -1), 'around');
            editor.focus();
            return;
        }

        const before = editor.getRange(
            { line: from.line, ch: Math.max(0, from.ch - wrap.length) }, from);
        const after = editor.getRange(to, { line: to.line, ch: to.ch + 1 });
        if (from.ch >= wrap.length && before === wrap && after === '}' &&
            bracesBalanced(sel)) {
            const start = { line: from.line, ch: from.ch - wrap.length };
            editor.replaceRange(sel, start, { line: to.line, ch: to.ch + 1 });
            const endCh = from.line === to.line ? to.ch - wrap.length : to.ch;
            editor.setSelection(start, { line: to.line, ch: endCh });
            editor.focus();
            return;
        }

        if (sel) {
            editor.replaceSelection(wrap + sel + '}', 'around');
        } else {
            editor.replaceSelection(wrap + '}');
            const c = editor.getCursor();
            editor.setCursor({ line: c.line, ch: c.ch - 1 });
        }
        editor.focus();
    }

    // ── List insertion (itemize / enumerate) ──────────────────────
    // Count net open itemize/enumerate environments strictly above `line`,
    // so a click on a `\begin{...}` line still reports the outer depth.
    function listDepthAt(line) {
        let depth = 0;
        for (let i = 0; i < line; i++) {
            const text   = editor.getLine(i) || '';
            const begins = text.match(/\\begin\{(?:itemize|enumerate)\}/g);
            const ends   = text.match(/\\end\{(?:itemize|enumerate)\}/g);
            if (begins) depth += begins.length;
            if (ends)   depth -= ends.length;
        }
        return Math.max(0, depth);
    }

    // Compact enumitem options for a first-level sublist.
    // Depth 0 → plain env; depth ≥ 2 → no opts (falls back to the LaTeX
    // default, i.e. asterisk for itemize and alpha for enumerate).
    function listOptsFor(env, depth) {
        if (depth !== 1) return '';
        if (env === 'itemize')
            return '[label=$\\circ$,leftmargin=1.5em,topsep=0.3em,itemsep=0.15em]';
        if (env === 'enumerate')
            return '[label=\\alph*.,leftmargin=1.5em,topsep=0.3em,itemsep=0.15em]';
        return '';
    }

    // Shared insert routine for itemize/enumerate and the fixed exercise
    // variants. `forcedOpts`, when defined, overrides depth-based opts.
    function insertList(env, forcedOpts) {
        if (!editor) return;
        const from = editor.getCursor('from');
        const sel  = editor.getSelection();

        const depth = listDepthAt(from.line);
        const opts  = forcedOpts !== undefined ? forcedOpts : listOptsFor(env, depth);

        // Indent from the current line so a sublist aligns under its parent
        // item. Depth 0 anchors at column 0.
        const currentLine = editor.getLine(from.line) || '';
        const lead = depth === 0 ? '' : (currentLine.match(/^\s*/)[0] || '');
        const beginIndent = depth === 0 ? '' : lead + '    ';
        const itemIndent  = depth === 0 ? '    ' : lead + '        ';

        const beginLine = `${beginIndent}\\begin{${env}}${opts}`;
        const endLine   = `${beginIndent}\\end{${env}}`;

        let items;
        if (sel && sel.trim()) {
            const parts = sel.split(/\r?\n/)
                .map(l => l.replace(/^\s+/, '').replace(/\s+$/, ''))
                .map(l => l.replace(/^\\item\b(?:\[[^\]]*\])?\s*/, ''))
                .filter(l => l.length);
            items = parts.length
                ? parts.map(l => `${itemIndent}\\item ${l}`)
                : [`${itemIndent}\\item `];
        } else {
            items = [`${itemIndent}\\item `];
        }

        const block = [beginLine, ...items, endLine].join('\n');

        if (sel) {
            editor.replaceSelection(block, 'around');
            // Place cursor at end of the first \item so typing continues there.
            editor.setCursor({ line: from.line + 1, ch: items[0].length });
        } else {
            let firstItemLine;
            if (!currentLine.trim()) {
                editor.replaceRange(
                    block,
                    { line: from.line, ch: 0 },
                    { line: from.line, ch: currentLine.length }
                );
                firstItemLine = from.line + 1;
            } else {
                editor.replaceRange('\n' + block, { line: from.line, ch: currentLine.length });
                firstItemLine = from.line + 2;
            }
            editor.setCursor({ line: firstItemLine, ch: items[0].length });
        }
        editor.focus();
    }

    // ── Hyperref link ─────────────────────────────────────────────
    // Escapes the three characters hyperref does NOT auto-handle inside
    // \href{}{}: `\` (invalid in URLs anyway → percent-encoded), `%` and
    // `#`. Done char-by-char so a `\` that becomes `%5C` isn't itself
    // re-escaped by the `%` rule.
    function escapeLatexUrl(url) {
        let out = '';
        for (const ch of url) {
            if      (ch === '\\') out += '%5C';
            else if (ch === '%')  out += '\\%';
            else if (ch === '#')  out += '\\#';
            else out += ch;
        }
        return out;
    }

    // Wraps a selected URL in `\href{escaped}{}` with the cursor placed
    // inside the visible-text braces. With no selection, inserts an empty
    // template and drops the cursor in the URL braces first.
    function insertHref() {
        if (!editor) return;
        const sel = editor.getSelection();
        if (!sel) {
            editor.replaceSelection('\\href{}{}');
            const c = editor.getCursor();
            editor.setCursor({ line: c.line, ch: c.ch - 3 });
            editor.focus();
            return;
        }
        editor.replaceSelection(`\\href{${escapeLatexUrl(sel.trim())}}{}`, 'around');
        const c = editor.getCursor();
        editor.setCursor({ line: c.line, ch: c.ch - 1 });
        editor.focus();
    }

    // ── Simple env wrapping (center / flushright) ─────────────────
    function wrapEnv(env) {
        if (!editor) return;
        const from = editor.getCursor('from');
        const sel  = editor.getSelection();
        const lineText = editor.getLine(from.line) || '';
        const lead = lineText.match(/^\s*/)[0] || '';

        if (sel) {
            editor.replaceSelection(`\\begin{${env}}\n${sel}\n\\end{${env}}`, 'around');
        } else {
            const inner = `${lead}    `;
            const block = `\\begin{${env}}\n${inner}\n\\end{${env}}`;
            if (!lineText.trim()) {
                editor.replaceRange(
                    block,
                    { line: from.line, ch: 0 },
                    { line: from.line, ch: lineText.length }
                );
                editor.setCursor({ line: from.line + 1, ch: inner.length });
            } else {
                editor.replaceRange('\n' + block, { line: from.line, ch: lineText.length });
                editor.setCursor({ line: from.line + 2, ch: inner.length });
            }
        }
        editor.focus();
    }

    // Appends ` \\` to each non-empty selected line (LaTeX forced newline).
    // Skips lines that already end with `\\` to keep repeated clicks idempotent.
    function addLineSkips() {
        if (!editor) return;
        const sel = editor.getSelection();
        if (!sel) return;
        const out = sel.split(/\r?\n/).map(l => {
            const trimmed = l.replace(/\s+$/, '');
            if (trimmed.endsWith('\\\\')) return l;
            return trimmed ? trimmed + ' \\\\' : '\\\\';
        }).join('\n');
        editor.replaceSelection(out, 'around');
        editor.focus();
    }

    // Inserts raw TeX without touching the selection: a paragraph break goes
    // after it (ends the paragraph), `\indent` before it. The trailing space
    // keeps a control word from fusing with following letters.
    function insertAt(tex, where) {
        if (!editor) return;
        editor.replaceRange(tex + ' ', editor.getCursor(where));
        editor.focus();
    }

    // ── Toolbar dropdown groups ───────────────────────────────────
    // Each `.latex-btn-group` has one toggle + one menu; only one may be
    // open at a time. Clicking a menu item runs its handler (via bubbling)
    // and then closes the menu; clicking outside closes all.
    function initToolbarGroups() {
        const groups = Array.from(document.querySelectorAll('.latex-btn-group'));
        if (!groups.length) return;

        const closeAll = () => groups.forEach(g => g.classList.remove('open'));

        groups.forEach(g => {
            const toggle = g.querySelector('[data-latex-group-toggle]');
            const menu   = g.querySelector('[data-latex-group-menu]');
            if (!toggle || !menu) return;

            toggle.addEventListener('click', e => {
                e.stopPropagation();
                const wasOpen = g.classList.contains('open');
                closeAll();
                if (!wasOpen) g.classList.add('open');
            });
            menu.addEventListener('click', e => {
                if (e.target.closest('.latex-menu-item')) closeAll();
            });
        });

        document.addEventListener('click', e => {
            if (!e.target.closest('.latex-btn-group')) closeAll();
        });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') closeAll();
        });
    }

    // ── tcolorbox snippets ────────────────────────────────────────
    // The box styles are defined in the Lecture notes template preamble.
    const BOX_STYLES = {
        definition: 'definitionBox',
        note:       'noteBox',
        example:    'exampleBox',
        text:       'textBox',
        generic:    'genericBox',
    };

    const BOX_SNIPPETS = {
        en: {
            definition:
`\\begin{tcolorbox}[definitionBox, title=Definition 1.1]
A \\emph{definition} states a concept precisely and formally. This box has a highlighted title and a soft background for comfortable reading.
\\end{tcolorbox}`,
            note:
`\\begin{tcolorbox}[noteBox, title=Note]
A quieter box with a coloured side bar. Useful for side comments that should not break the flow of the main text.
\\end{tcolorbox}`,
            example:
`\\begin{tcolorbox}[exampleBox, title=Example 1.1]
Let $f(x) = x^2 + 2x + 1$. Then:
\\[ f(x) = (x+1)^2 \\]
Example boxes have their own style so they stand apart from definitions.
\\end{tcolorbox}`,
            text:
`\\begin{tcolorbox}[textBox]
Lorem ipsum dolor sit amet,\\\\
consectetur adipiscing elit.\\\\
\\\\
In eu purus ex.\\\\
Pellentesque vestibulum felis posuere consequat ornare.
\\end{tcolorbox}`,
            generic:
`\\begin{tcolorbox}[genericBox]
A plain box.\\\\
\\\\
Write whatever you like here.
\\end{tcolorbox}`,
        },
        pt: {
            definition:
`\\begin{tcolorbox}[definitionBox, title=Definição 1.1]
Uma \\emph{definição} é uma explicação precisa e formal de um conceito. Este box tem título destacado e fundo suave para leitura confortável.
\\end{tcolorbox}`,
            note:
`\\begin{tcolorbox}[noteBox, title=Observação]
Um box de observação mais discreto, com barra lateral colorida. Útil para comentários paralelos ao texto principal sem quebrar o fluxo de leitura.
\\end{tcolorbox}`,
            example:
`\\begin{tcolorbox}[exampleBox, title=Exemplo 1.1]
Considere $f(x) = x^2 + 2x + 1$. Então:
\\[ f(x) = (x+1)^2 \\]
Boxes de exemplo têm estilo próprio para diferenciá-los das definições.
\\end{tcolorbox}`,
            text:
`\\begin{tcolorbox}[textBox]
Lorem ipsum dolor sit amet,\\\\
consectetur adipiscing elit.\\\\
\\\\
In eu purus ex.\\\\
Pellentesque vestibulum felis posuere consequat ornare.
\\end{tcolorbox}`,
            generic:
`\\begin{tcolorbox}[genericBox]
Uma caixa simples.\\\\
\\\\
Escreva o que quiser aqui.
\\end{tcolorbox}`,
        },
    };

    // Drops a snippet at the cursor; puts it on its own line when the
    // current line already has content, replaces the line when it's empty.
    function insertSnippet(snippet) {
        if (!editor) return;
        const from = editor.getCursor('from');
        const lineText = editor.getLine(from.line) || '';
        if (!lineText.trim()) {
            editor.replaceRange(
                snippet,
                { line: from.line, ch: 0 },
                { line: from.line, ch: lineText.length }
            );
        } else {
            editor.replaceRange('\n' + snippet, { line: from.line, ch: lineText.length });
        }
        editor.focus();
    }

    function insertBox(kind) {
        const lang = window.Studio.i18n.lang;
        insertSnippet((BOX_SNIPPETS[lang] || BOX_SNIPPETS.en)[kind]);
        const style = BOX_STYLES[kind];
        if (!editor.getValue().includes(style + '/.style')) {
            setStatus('"{style}" is defined in the Lecture notes preamble — copy it over if this document lacks it',
                'loading', { style });
        }
    }

    // Opens a compiled PDF preserving zoom, rotation and scroll position.
    // Returns false if the user chose to keep the current annotated view.
    async function openInViewer(url) {
        const app = await ensureViewer();

        // Highlights/drawings/text/signatures live on the old document
        // and would be silently destroyed by the reload.
        if (app.pdfDocument && app.pdfDocument.annotationStorage.size > 0) {
            const replace = window.confirm(t(
                'The current PDF has annotations (highlights, drawings, text…) that will be lost when the preview refreshes.\n\nTo keep them, cancel and download the PDF with the viewer\'s save button.\n\nReplace anyway?'));
            if (!replace) return false;
        }

        const pv   = app.pdfViewer;
        const cont = pv.container;
        const prev = app.pdfDocument ? {
            top:      cont.scrollTop,
            left:     cont.scrollLeft,
            scale:    pv.currentScaleValue,
            rotation: pv.pagesRotation,
        } : null;

        // The reload resets the PDF container to 0, which would fire a
        // sync event and drag the editor to the top — mute until the
        // scroll restore below has run.
        syncMuted = true;
        try {
            const pagesLoaded = new Promise(res =>
                app.eventBus.on('pagesloaded', res, { once: true }));
            await app.open({ url });
            showPdfFrame();
            await pagesLoaded;
            buildSyncAnchors(app).catch(e =>
                console.warn('[latex-studio] sync anchors failed:', e));

            if (prev) {
                try {
                    if (prev.scale && pv.currentScaleValue !== prev.scale) pv.currentScaleValue = prev.scale;
                    if (prev.rotation) pv.pagesRotation = prev.rotation;
                } catch { /* view-state restore is best-effort */ }
            }
            await new Promise(res => requestAnimationFrame(() => {
                if (prev) {
                    cont.scrollTop  = Math.min(prev.top, cont.scrollHeight - cont.clientHeight);
                    cont.scrollLeft = prev.left;
                }
                requestAnimationFrame(res); // let the restore's scroll event pass while muted
            }));
        } finally {
            syncMuted = false;
        }
        return true;
    }

    // ── Documents ─────────────────────────────────────────────────
    function newId() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2);
    }

    async function fetchTemplate(id) {
        const lang = window.Studio.i18n.lang;
        try {
            const res = await fetch(`templates/${lang}/${id}.tex`);
            if (!res.ok) throw new Error('not found');
            return await res.text();
        } catch (e) {
            console.error('[latex-studio] failed to load template', id, e);
            return `\\documentclass{article}\n\\begin{document}\nNo template.\n\\end{document}\n`;
        }
    }

    async function templateContent(templateId, title) {
        return (await fetchTemplate(templateId)).replace(/\{\{title\}\}/g, title);
    }

    // Puts the editor in unsaved-draft mode: no localStorage write until
    // the user explicitly clicks Save. Switching away discards the draft.
    async function openDraft(templateId, title) {
        const content = await templateContent(templateId, title);
        currentDocId = null;
        editor.setValue(content);
        editor.clearHistory();
        document.getElementById('latex-doc-name').value = title;
        clearPreview();
        refreshDocList();
        setStatus('Draft — not saved', 'loading');
    }

    function loadDoc(id) {
        const doc = getDocs().find(d => d.id === id);
        if (!doc) return false;
        currentDocId = id;
        setActiveId(id);
        editor.setValue(doc.content);
        editor.clearHistory();
        document.getElementById('latex-doc-name').value = doc.name;
        clearPreview();
        refreshDocList();
        setStatus('', '');
        return true;
    }

    function saveCurrentDoc() {
        if (!editor) return;
        const name    = document.getElementById('latex-doc-name').value.trim() || t('Untitled');
        const content = editor.getValue();
        const docs    = getDocs();

        // Draft — persist as a new document on first save.
        if (!currentDocId) {
            const d = { id: newId(), name, content, updatedAt: Date.now() };
            docs.push(d);
            saveDocs(docs);
            currentDocId = d.id;
            setActiveId(d.id);
            refreshDocList();
            setStatus('Saved', 'ok');
            return;
        }

        const idx = docs.findIndex(d => d.id === currentDocId);
        if (idx < 0) return;
        docs[idx].name      = name;
        docs[idx].content   = content;
        docs[idx].updatedAt = Date.now();
        saveDocs(docs);
        refreshDocList();
        setStatus('Saved', 'ok');
    }

    // Auto-save when leaving an already-persisted doc; drafts are discarded.
    function autosaveIfPersisted() {
        if (currentDocId) saveCurrentDoc();
    }

    function refreshDocList() {
        const sel = document.getElementById('latex-docs-select');
        if (!sel) return;
        sel.innerHTML = '';
        for (const d of getDocs()) {
            const opt = document.createElement('option');
            opt.value = d.id;
            opt.textContent = d.name;
            opt.selected = d.id === currentDocId;
            sel.appendChild(opt);
        }
    }

    function refreshTemplateSelect() {
        const sel = document.getElementById('latex-template-select');
        if (!sel) return;
        sel.innerHTML = '';
        const head = document.createElement('option');
        head.value = '';
        head.textContent = t('+ Template…');
        sel.appendChild(head);
        for (const tpl of TEMPLATES) {
            const opt = document.createElement('option');
            opt.value = tpl.id;
            opt.textContent = t(tpl.label);
            sel.appendChild(opt);
        }
    }

    // ── Compile ───────────────────────────────────────────────────
    // Resolves true when a PDF was produced (whether or not the viewer took it).
    async function compile() {
        if (!editor) return false;
        const ok = await ensureEngine();
        if (!ok) return false;

        setStatus('Compiling…', 'loading');
        const src = editor.getValue();

        try {
            engine.writeMemFSFile('main.tex', src);
            engine.setEngineMainFile('main.tex');
            // PdfTeXEngine never rejects on worker death; race against onerror.
            const crashed = new Promise((_, reject) => {
                if (engine.latexWorker) {
                    engine.latexWorker.onerror = e =>
                        reject(new Error(e?.message || 'engine crashed'));
                }
            });
            const result = await Promise.race([engine.compileLaTeX(), crashed]);

            if (result.status === 0 && result.pdf?.length) {
                const url = URL.createObjectURL(new Blob([result.pdf], { type: 'application/pdf' }));
                setStatus('Compiled successfully', 'ok');
                // A viewer failure must not reach the outer catch — that
                // would needlessly reset a perfectly healthy engine.
                try {
                    if (await openInViewer(url)) {
                        if (currentPdfUrl) URL.revokeObjectURL(currentPdfUrl);
                        currentPdfUrl = url;
                    } else {
                        // User kept the annotated view; discard this build.
                        URL.revokeObjectURL(url);
                        setStatus('View kept — recompile to refresh', 'loading');
                    }
                } catch (e) {
                    URL.revokeObjectURL(url);
                    console.error('[latex-studio] pdf viewer failed:', e);
                    setStatus('Could not display the PDF', 'error');
                }
                return true;
            }
            setStatus('Compile error — see the log', 'error');
            showLog(result.log || t('(no log)'));
            return false;
        } catch (e) {
            resetEngine();
            setStatus('Engine error: {error} — try compiling again', 'error', { error: e.message });
            console.error('[latex-studio] compile error:', e);
            return false;
        }
    }

    function downloadPdf() {
        if (!currentPdfUrl) { setStatus('Compile first', 'error'); return; }
        const name = (document.getElementById('latex-doc-name').value.trim() || 'document') + '.pdf';
        const a = document.createElement('a');
        a.href = currentPdfUrl;
        a.download = name;
        a.click();
    }

    // ── Editor search (Ctrl+F) ────────────────────────────────────
    // Browser-style find bar scoped to the editor: highlights every
    // match and shows "current/total" enumeration.
    let searchMatches    = [];
    let searchMarks      = [];
    let searchActiveMark = null;
    let searchIndex      = -1;
    let searchTimer      = null;
    const searchEls      = {};

    function searchInit() {
        searchEls.bar   = document.getElementById('latex-search-bar');
        searchEls.input = document.getElementById('latex-search-input');
        searchEls.count = document.getElementById('latex-search-count');
        if (!searchEls.bar) return;

        searchEls.input.addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(searchUpdate, 120);
        });
        searchEls.input.addEventListener('keydown', e => {
            if (e.key === 'Enter')       { e.preventDefault(); searchGo(e.shiftKey ? -1 : 1); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); searchClose(); }
        });
        document.getElementById('latex-search-prev').addEventListener('click', () => searchGo(-1));
        document.getElementById('latex-search-next').addEventListener('click', () => searchGo(1));
        document.getElementById('latex-search-close').addEventListener('click', searchClose);
    }

    function searchOpen() {
        if (!searchEls.bar) return;
        searchEls.bar.style.display = 'flex';
        const sel = editor.getSelection();
        if (sel && !sel.includes('\n')) searchEls.input.value = sel;
        searchEls.input.focus();
        searchEls.input.select();
        searchUpdate();
    }

    function searchClose() {
        if (!searchEls.bar) return;
        searchEls.bar.style.display = 'none';
        searchClearMarks();
        editor.focus();
    }

    function searchIsOpen() {
        return searchEls.bar && searchEls.bar.style.display !== 'none';
    }

    function searchClearMarks() {
        searchMarks.forEach(m => m.clear());
        searchActiveMark?.clear();
        searchMarks      = [];
        searchActiveMark = null;
        searchMatches    = [];
        searchIndex      = -1;
        if (searchEls.count) searchEls.count.textContent = '0/0';
    }

    function searchUpdate() {
        searchClearMarks();
        const q = searchEls.input.value;
        if (!q) return;

        const cur = editor.getSearchCursor(q, null, { caseFold: true });
        while (cur.findNext()) {
            searchMatches.push({ from: cur.from(), to: cur.to() });
            if (searchMatches.length >= 5000) break; // safety cap
        }
        editor.operation(() => {
            for (const m of searchMatches) {
                searchMarks.push(editor.markText(m.from, m.to, { className: 'latex-search-match' }));
            }
        });
        if (!searchMatches.length) return;

        // Start from the first match at/after the cursor.
        const at  = editor.getCursor();
        const idx = searchMatches.findIndex(m => CodeMirror.cmpPos(m.from, at) >= 0);
        searchIndex = idx < 0 ? 0 : idx;
        searchGo(0);
    }

    function searchGo(delta) {
        if (!searchMatches.length) return;
        searchIndex = (searchIndex + delta + searchMatches.length) % searchMatches.length;
        const m = searchMatches[searchIndex];
        searchActiveMark?.clear();
        searchActiveMark = editor.markText(m.from, m.to, { className: 'latex-search-match-active' });
        editor.setCursor(m.from);
        editor.scrollIntoView({ from: m.from, to: m.to }, 60);
        searchEls.count.textContent = `${searchIndex + 1}/${searchMatches.length}`;
    }

    // ── Theme ─────────────────────────────────────────────────────
    // The initial theme is set by an inline script in <head> to avoid a flash.
    function initTheme() {
        const btn = document.getElementById('theme-toggle');
        if (!btn) return;
        btn.addEventListener('click', () => {
            const root   = document.documentElement;
            const isDark = root.dataset.theme === 'dark' ||
                (!root.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
            root.dataset.theme = isDark ? 'light' : 'dark';
            try { localStorage.setItem(THEME_KEY, root.dataset.theme); } catch {}
        });
    }

    // ── Init ──────────────────────────────────────────────────────
    function on(id, fn) {
        document.getElementById(id).addEventListener('click', fn);
    }

    async function init() {
        window.Studio.i18n.apply();
        refreshTemplateSelect();
        initTheme();

        editor = CodeMirror(document.getElementById('latex-source-pane'), {
            mode: 'stex',
            lineNumbers: true,
            lineWrapping: true,
            indentUnit: 4,
            tabSize: 4,
            extraKeys: {
                'Ctrl-Enter': compile,
                'Cmd-Enter':  compile,
                'Ctrl-S':     saveCurrentDoc,
                'Cmd-S':      saveCurrentDoc,
                'Ctrl-F':     searchOpen,
                'Cmd-F':      searchOpen,
                'Ctrl-B':     () => toggleWrap('textbf'),
                'Cmd-B':      () => toggleWrap('textbf'),
                'Ctrl-I':     () => toggleWrap('textit'),
                'Cmd-I':      () => toggleWrap('textit'),
            },
        });
        searchInit();

        // First visit: seed a real document so there is something to compile.
        let docs = getDocs();
        if (docs.length === 0) {
            const tpl = TEMPLATES.find(x => x.id === FIRST_RUN_TEMPLATE);
            const title = t(tpl.title);
            const d = { id: newId(), name: title, content: await templateContent(tpl.id, title), updatedAt: Date.now() };
            saveDocs([d]);
            docs = [d];
        }
        refreshDocList();
        if (!loadDoc(getActiveId())) loadDoc(docs[0].id);

        on('latex-compile-btn',  compile);
        on('latex-download-btn', downloadPdf);
        on('latex-save-btn',     saveCurrentDoc);

        on('latex-bold-btn',    () => toggleWrap('textbf'));
        on('latex-italic-btn',  () => toggleWrap('textit'));
        on('latex-emdash-btn',  () => { editor.replaceSelection('—'); editor.focus(); });
        on('latex-href-btn',    insertHref);

        on('latex-section-btn',       () => toggleWrap('section'));
        on('latex-subsection-btn',    () => toggleWrap('subsection'));
        on('latex-subsubsection-btn', () => toggleWrap('subsubsection'));

        on('latex-itemize-btn',    () => insertList('itemize'));
        on('latex-enumerate-btn',  () => insertList('enumerate'));
        on('latex-ex-answers-btn', () =>
            insertList('enumerate', '[label=\\alph*),leftmargin=1.5em,topsep=0.3em,itemsep=0.15em]'));
        on('latex-ex-steps-btn',   () =>
            insertList('enumerate', '[label=\\alph*.,leftmargin=1.5em,topsep=0.3em,itemsep=0.15em]'));

        on('latex-linebreak-btn',  addLineSkips);
        on('latex-blankpar-btn',   () => insertAt('\\par\\vspace{\\baselineskip}', 'to'));
        on('latex-indent-btn',     () => insertAt('\\indent', 'from'));
        on('latex-center-btn',     () => wrapEnv('center'));
        on('latex-flushright-btn', () => wrapEnv('flushright'));

        for (const kind of Object.keys(BOX_STYLES)) {
            on(`latex-box-${kind}-btn`, () => insertBox(kind));
        }

        initToolbarGroups();

        on('latex-new-btn', async () => {
            autosaveIfPersisted();
            await openDraft('blank', t('New Document'));
        });

        document.getElementById('latex-template-select').addEventListener('change', async e => {
            const tpl = TEMPLATES.find(x => x.id === e.target.value);
            e.target.value = '';
            if (!tpl) return;
            autosaveIfPersisted();
            await openDraft(tpl.id, t(tpl.title));
        });

        on('latex-delete-btn', () => {
            // Draft — just discard and load an existing doc.
            if (!currentDocId) {
                const docs = getDocs();
                if (docs.length === 0) { setStatus('No saved documents', 'error'); return; }
                loadDoc(docs[0].id);
                return;
            }
            let docs = getDocs();
            if (docs.length <= 1) { setStatus('Cannot delete the only document', 'error'); return; }
            const doc = docs.find(d => d.id === currentDocId);
            if (!window.confirm(t('Delete "{name}"? This cannot be undone.', { name: doc?.name || '' }))) return;
            docs = docs.filter(d => d.id !== currentDocId);
            saveDocs(docs);
            loadDoc(docs[0].id);
        });

        document.getElementById('latex-docs-select').addEventListener('change', e => {
            autosaveIfPersisted();
            loadDoc(e.target.value);
        });

        document.getElementById('latex-doc-name').addEventListener('keydown', e => {
            if (e.key === 'Enter') saveCurrentDoc();
        });

        // Focus mode hides the page header so the editor gets the full viewport.
        const fsBtn = document.getElementById('latex-fullscreen-btn');
        const fsLabel = () => t(document.body.classList.contains('latex-fullscreen') ? '⛶ Exit' : '⛶ Focus');
        function toggleFullscreen() {
            document.body.classList.toggle('latex-fullscreen');
            fsBtn.textContent = fsLabel();
            setTimeout(() => editor?.refresh(), 50);
        }
        fsBtn.textContent = fsLabel();
        fsBtn.addEventListener('click', toggleFullscreen);
        document.addEventListener('keydown', e => {
            if (e.key !== 'Escape') return;
            if (searchIsOpen()) { searchClose(); return; }
            if (document.body.classList.contains('latex-fullscreen')) toggleFullscreen();
        });

        // ── Sync scroll (on by default; ⇅ button toggles) ─────────
        const syncBtn = document.getElementById('latex-sync-btn');
        function setSyncScroll(enabled) {
            syncScroll = enabled;
            try { localStorage.setItem(SYNC_KEY, enabled ? '1' : '0'); } catch {}
            syncBtn.classList.toggle('latex-btn-toggled', enabled);
        }
        syncBtn.addEventListener('click', () => setSyncScroll(!syncScroll));
        let savedSync = null;
        try { savedSync = localStorage.getItem(SYNC_KEY); } catch {}
        setSyncScroll(savedSync !== '0');

        // Only the pane the user last hovered drives the other one, so a
        // programmatic scroll on the target pane can't echo back (no loop).
        // The PDF --> editor half is wired in wireViewerSync().
        editor.getWrapperElement().addEventListener('mouseenter', () => activePane = 'editor');
        editor.on('scroll', () => {
            if (syncMuted || !syncScroll || activePane !== 'editor' || !viewerApp?.pdfDocument) return;
            const px = computeSyncPixels(viewerApp);
            if (!px) return;
            viewerApp.pdfViewer.container.scrollTop =
                mapSync(editor.getScrollInfo().top, px.ed, px.pdf);
        });

        // ── Language switch ───────────────────────────────────────
        // Document contents are never translated; only the chrome is.
        const langBtn = document.getElementById('lang-toggle');
        const langLabel = () => window.Studio.i18n.lang === 'pt' ? 'EN' : 'PT';
        langBtn.textContent = langLabel();
        langBtn.addEventListener('click', () =>
            window.Studio.i18n.setLang(window.Studio.i18n.lang === 'pt' ? 'en' : 'pt'));
        onLangChange(() => {
            langBtn.textContent = langLabel();
            fsBtn.textContent = fsLabel();
            refreshTemplateSelect();
            renderStatus();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
