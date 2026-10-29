import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const root = new URL("../site/", import.meta.url);
const files = new Map([
  ["index.html", "text/html"], ["style.css", "text/css"], ["config.json", "application/json"],
  ["app.js", "text/javascript"], ["shared.js", "text/javascript"], ["store.js", "text/javascript"],
  ["diagnostics.js", "text/javascript"],
  ["sw.js", "text/javascript"], ["push-handler.js", "text/javascript"], ["icon.svg", "image/svg+xml"],
]);
const prefix = "/notification-test-site/";
createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost:8769");
  if (url.pathname === "/") {
    response.writeHead(302, { Location: prefix }).end();
    return;
  }
  const name = url.pathname.startsWith(prefix)
    ? url.pathname.slice(prefix.length) || "index.html" : "";
  if (request.method !== "GET" || !files.has(name)) {
    response.writeHead(404).end("Not found");
    return;
  }
  try {
    const data = await readFile(new URL(name, root));
    response.writeHead(200, {
      "Content-Type": `${files.get(name)}; charset=utf-8`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    }).end(data);
  } catch (error) {
    console.error(`Cannot serve ${name}: ${error.code}`);
    response.writeHead(500).end("Cannot read fixture file");
  }
}).listen(8769, "127.0.0.1", () => {
  console.log(`Serving http://localhost:8769${prefix}`);
});
