import { createServer } from "http";
import { execFile } from "child_process";
import { promisify } from "util";
import chokidar from "chokidar";
import { WebSocketServer } from "ws";
import { gzip as gzipCb } from "zlib";

function toMB(n) {
  return (n / (1024 * 1024)).toFixed(3);
}

const exec = promisify(execFile);
const gzip = promisify(gzipCb);

const MD_FILE = process.argv[2];
if (!MD_FILE) {
  console.error("Usage: node server.mjs <file.md>");
  process.exit(1);
}

const PORT = 8080;

let html;
async function build(signal) {
  try {
    const { stdout, stderr } = await exec("pandoc", ["-d", "defaults/archive.yml", MD_FILE], {
      signal,
      maxBuffer: 64 * 1024 * 1024,
    });
    stderr && console.warn(stderr);
    html = stdout;
  } catch (err) {
    html = undefined;
    console.error("Build failed: " + err.message);
  }
}

const liveReloadScript = /* html */ `
<script>
  const ws = new WebSocket('ws://' + location.host);
  ws.onmessage = () => location.reload()
</script>`;

function injectScript(html) {
  return html.replace("</body>", liveReloadScript + "</body>");
}

console.info("Building . . .");
await build();
if (!html) {
  process.exit(1);
}

const server = createServer(async (req, res) => {
  try {
    if (!html) {
      throw new Error("build output not ready");
    }

    const file = Buffer.from(injectScript(html), "utf-8");
    const compressed = await gzip(file, { level: 6 });
    const ratio = file.length / compressed.length;
    console.info(`Compressed: ${toMB(compressed.length)}/${toMB(file.length)}MB (ratio ${ratio.toFixed(1)}x)`);

    res.writeHead(200, {
      "content-type": "text/html",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
      "content-encoding": "gzip",
    });
    res.end(compressed);
  } catch (err) {
    console.error("Serve request", err);
    res.writeHead(500);
  }
});

const wss = new WebSocketServer({ server });
const clients = new Set();
wss.on("connection", (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
});

const watcher = chokidar.watch(["template", "static", "filters", "defaults/archive.yml"], {
  persistent: true,
  ignoreInitial: true,
});

let rebuildTimeout, controller;

watcher.on("change", () => {
  clearTimeout(rebuildTimeout);
  controller?.abort();

  rebuildTimeout = setTimeout(async () => {
    console.info("Rebuilding . . .");

    controller = new AbortController();
    await build(controller.signal);

    clients.forEach((c) => c.send("reload"));
  }, 150);
});

watcher.on("error", (err) => console.error("Watcher error:", err));

server.listen(PORT, () => console.info(`Server running at http://localhost:${PORT}`));
