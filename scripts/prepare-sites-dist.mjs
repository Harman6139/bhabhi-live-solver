import { copyFile, cp, mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const buildDirectory = resolve(root, "dist");
const clientDirectory = resolve(buildDirectory, "client");
const serverDirectory = resolve(buildDirectory, "server");

// Sites binds static assets from the Cloudflare Vite client output. Vite's
// default SPA build is flat, so retain it and mirror the public files into the
// expected client directory before packaging.
await mkdir(clientDirectory, { recursive: true });
for (const entry of await readdir(buildDirectory, { withFileTypes: true })) {
  if (
    entry.name === "client" ||
    entry.name === "server" ||
    entry.name === ".openai"
  ) {
    continue;
  }
  await cp(
    resolve(buildDirectory, entry.name),
    resolve(clientDirectory, entry.name),
    { recursive: entry.isDirectory() },
  );
}

await mkdir(serverDirectory, { recursive: true });
await copyFile(
  resolve(root, "sites", "worker.js"),
  resolve(serverDirectory, "index.js"),
);
