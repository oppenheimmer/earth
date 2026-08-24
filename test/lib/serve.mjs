// Static file server for one app root. Node's http rather than python3 -m http.server so
// the suite has no dependency outside the runtime it is already written in, and so caching
// can be turned off outright — a stale js/wind.js would silently compare a build against
// itself.
import {createServer} from "node:http";
import {createReadStream, promises as fs} from "node:fs";
import {extname, join, normalize} from "node:path";

const TYPES = {
    ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
    ".css": "text/css", ".json": "application/json", ".webp": "image/webp",
    ".jpg": "image/jpeg", ".png": "image/png", ".ico": "image/x-icon"
};

/** Serves `root` on an OS-assigned port. Resolves to {port, close}. */
export async function serve(root) {
    const server = createServer(async (req, res) => {
        // Strip the query and hash, then confine the path to the root: a request is a
        // filename here, never a traversal.
        const rel = normalize(decodeURIComponent(req.url.split(/[?#]/)[0])).replace(/^(\.\.[/\\])+/, "");
        const path = join(root, rel === "/" ? "index.html" : rel);

        try {
            const stat = await fs.stat(path);
            if (stat.isDirectory()) throw new Error("directory");

            res.writeHead(200, {
                "content-type": TYPES[extname(path)] || "application/octet-stream",
                "content-length": stat.size,
                "cache-control": "no-store"
            });
            createReadStream(path).pipe(res);
        }
        catch {
            res.writeHead(404, {"content-type": "text/plain"});
            res.end("not found");
        }
    });

    await new Promise((done) => server.listen(0, "127.0.0.1", done));

    return {
        port: server.address().port,
        close: () => new Promise((done) => server.close(done))
    };
}
