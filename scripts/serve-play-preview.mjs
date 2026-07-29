import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? "dist");
const port = Number.parseInt(process.env.PORT ?? "4173", 10);
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function fileFor(requestUrl) {
  const pathname = new URL(requestUrl ?? "/", "http://127.0.0.1").pathname;
  const decoded = decodeURIComponent(pathname);
  const candidate = resolve(root, `.${normalize(decoded)}`);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    return null;
  }
  try {
    return statSync(candidate).isFile() ? candidate : join(root, "index.html");
  } catch {
    return join(root, "index.html");
  }
}

createServer((request, response) => {
  const file = fileFor(request.url);
  if (file === null) {
    response.writeHead(400);
    response.end("Invalid path.");
    return;
  }
  try {
    const headers = {
      "Cache-Control": "no-store",
      "Content-Type": contentTypes[extname(file)] ?? "application/octet-stream",
    };
    response.writeHead(200, headers);
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404);
    response.end("Not found.");
  }
}).listen(port, "127.0.0.1", () => {
  process.stdout.write(
    `Unvalidated Bhabhi play preview: http://127.0.0.1:${port.toString()}\n`,
  );
});
