/**
 * Local static server for web/, matching production URL rules.
 *
 * The pages link to ./docs without an extension, which Vercel resolves through
 * cleanUrls. A plain static server returns 404 for it, so the Docs link and the
 * whole menu look broken when the site is fine. This resolves extensionless
 * paths the same way, so what you see locally is what deploys.
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../web/", import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  // Served as octet-stream otherwise, which means the social card cannot be
  // previewed locally and robots.txt downloads instead of opening.
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

async function resolve(pathname) {
  // Strip the leading slash and normalise away any ../ before it can escape.
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  const base = join(ROOT, rel);
  if (!base.startsWith(ROOT)) return null;

  const candidates = base.endsWith("/") || rel === ""
    ? [join(base, "index.html")]
    : [base, `${base}.html`, join(base, "index.html")];

  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // try the next shape
    }
  }
  return null;
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  const file = await resolve(pathname);

  if (!file) {
    // Vercel serves web/404.html for an unknown path, so serving a line of
    // plain text here would hide the one page you cannot reach by clicking.
    // Falls back to text only if the file is missing.
    try {
      const notFound = await readFile(join(ROOT, "404.html"));
      res.writeHead(404, {
        "content-type": TYPES[".html"],
        "cache-control": "no-store",
      });
      res.end(notFound);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end(`404 ${pathname}`);
    }
    return;
  }

  const body = await readFile(file);
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  res.end(body);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`scrip web -> http://127.0.0.1:${PORT}`);
});
