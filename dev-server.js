// Minimal static server for local development.
//
//   node dev-server.js        → http://localhost:8321
//
// Two things a generic static server may get wrong are handled here:
//   - `.mjs` must be served as JavaScript, or the pdf.js viewer fails to load.
//   - PUT /tex/texlive/pdftex/10/swiftlatexpdftex.fmt saves a rebuilt format file
//     (sent by tex/compile-format.html). No other path accepts writes.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8321;
const FMT_URL = '/tex/texlive/pdftex/10/swiftlatexpdftex.fmt';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.tex': 'text/plain; charset=utf-8',
    '.ftl': 'text/plain; charset=utf-8',
};

http.createServer((req, res) => {
    // Collapse leading slashes: `//foo` would otherwise parse as a host, not a path.
    let urlPath;
    try {
        urlPath = decodeURIComponent(new URL(req.url.replace(/^\/+/, '/'), 'http://x').pathname);
    } catch {
        res.writeHead(400); res.end('bad request'); return;
    }
    if (urlPath === '/') urlPath = '/index.html';

    if (req.method === 'PUT') {
        if (urlPath !== FMT_URL) { res.writeHead(403); res.end('forbidden'); return; }
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            const buf = Buffer.concat(chunks);
            fs.writeFileSync(path.join(ROOT, FMT_URL), buf);
            console.log('saved fmt:', buf.length, 'bytes');
            res.writeHead(200); res.end('ok');
        });
        return;
    }

    const safe = path.normalize(urlPath).replace(/^([/\\])+/, '');
    const file = path.join(ROOT, safe);
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-store',
        });
        res.end(data);
    });
}).listen(PORT, () => {
    console.log(`LaTeX Studio → http://localhost:${PORT}`);
});
