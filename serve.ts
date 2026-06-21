import { createServer, type IncomingMessage, type OutgoingHttpHeaders, request } from "http";
import { execFile, spawn } from "child_process";
import chokidar from "chokidar";
import { WebSocketServer, type WebSocket } from "ws";
import { gzip as gzipCb } from "zlib";
import { copyFile, readFile, unlink } from "fs/promises";
import path from "path";
import { promisify } from "util";
import mime from "mime";
import { randomBytes } from "crypto";

function toMB(n: number) {
  return (n / (1024 * 1024)).toFixed(3);
}

const gzip = promisify(gzipCb);

if (process.argv.length < 3) {
  console.error("Usage: node server.js <root-path>");
  process.exit(1);
}

const IN_DIR = path.resolve(process.argv[2]);
const OUT_DIR = path.resolve("out");
const DEFAULTS = "defaults/archive.yml";
const PORT = Number.parseInt(process.env.PORT || "") || 8080;

let AUTH_PORT = Number.parseInt(process.env.AUTH_PORT || "") || 9000;
if (AUTH_PORT === PORT) AUTH_PORT++;

type Change = { kind: "A" | "M" | "D"; path: string };

async function build(signal?: AbortSignal, changed?: Change[], full?: boolean) {
  try {
    const args = ["run", "./build", `-in=${IN_DIR}`, `-out=${OUT_DIR}`].concat(full ? ["-full"] : []);
    const { promise, resolve, reject } = Promise.withResolvers();
    const child = execFile("go", args, { signal, env: { ...process.env, DEV: "1" } }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
    if (changed?.length) {
      child.stdin!.write(changed.map((c) => `${c.kind}\x00${c.path}\x00`).join(""));
    }
    child.stdin!.end();
    child.stderr!.pipe(process.stderr);
    await promise;
    return true;
  } catch (err: any) {
    console.error("Build failed: " + err.message);
    return false;
  }
}

const liveReloadScript = /* html */ `
<script>
  const ws = new WebSocket(location.protocol.replace('http', 'ws') + '//' + location.host);
  ws.onmessage = () => location.reload()

  if (location.pathname.startsWith('/me')) {
    fetch('/auth', { method: 'POST' })
      .then(res => {
        if (!res.ok) throw new Error('unauthorized')
      })
      .catch(err => {
        alert('Authorization failed: ' + err.message)
      })
  }
</script>`;

function injectScript(html: string) {
  return html.replace("</body>", liveReloadScript + "</body>");
}

function startAuthProxy() {
  return spawn("go", ["run", "./auth"], {
    stdio: "inherit",
    detached: true,
    env: {
      ...process.env,
      GOEXPERIMENT: "jsonv2",
      RP_ORIGIN: `http://localhost:${PORT}`,
      HMAC_SECRET: process.env.HMAC_SECRET || randomBytes(32).toString("hex"),
      USER_FILE: path.join("auth", "user.local.json"),
      LINKS_FILE: path.join("auth", "links.local.json"),
      ADDR: `localhost:${AUTH_PORT}`,
      REGISTER_ADDR: `localhost:${AUTH_PORT + 1}`,
      WEB_ROOT: OUT_DIR,
    },
  });
}

async function tryReadFile(...paths: string[]) {
  let lastErr: any;
  for (const p of paths) {
    try {
      return [await readFile(p), mime.getType(path.extname(p).replace(".", "")) || "application/octet-stream"] as const;
    } catch (err: any) {
      lastErr = err;
      if (err.code !== "ENOENT" && err.code !== "EISDIR") {
        throw err;
      }
    }
  }
  lastErr.code = "ENOENT";
  throw lastErr;
}

const server = createServer(async (req, res) => {
  try {
    if (req.url?.startsWith("/auth")) {
      const target = new URL(req.url.replace(/^\/auth/, ""), `http://localhost:${AUTH_PORT}`);
      const proxyRes = await new Promise<IncomingMessage>((resolve, reject) => {
        const proxyReq = request(
          target,
          {
            method: req.method,
            headers: { ...req.headers, host: target.host },
          },
          resolve,
        );
        proxyReq.on("error", reject);
        req.pipe(proxyReq);
      });

      res.writeHead(proxyRes.statusCode!, proxyRes.headers);
      proxyRes.pipe(res);

      return;
    }

    const url = new URL(req.url || "", `http://localhost:${PORT}`);
    const filepath = path.join(
      OUT_DIR,
      path
        .normalize(url.pathname)
        .replace(/^(\.\.\/)+/, "")
        .replace(/\/+$/, ""),
    );
    const [file, contentType] = await tryReadFile(filepath, `${filepath}.html`, `${filepath}/index.html`);

    let data = file;
    if (contentType === "text/html") {
      data = await gzip(injectScript(data.toString("utf-8")), { level: 6 });
      const ratio = file.length / data.length;
      console.info(`Compressed: ${toMB(data.length)}/${toMB(file.length)}MB (ratio ${ratio.toFixed(1)}x)`);
    } else if (contentType.startsWith("text/")) {
      data = await gzip(data, { level: 6 });
    }

    const headers: OutgoingHttpHeaders = {
      "content-type": contentType,
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
    };
    if (contentType.startsWith("text/")) {
      headers["content-encoding"] = "gzip";
    }

    res.writeHead(200, headers);
    res.end(data);
  } catch (err: any) {
    if (err.code === "ENOENT") {
      res.writeHead(404);
    } else {
      res.writeHead(500);
    }
    res.end();
    console.error("Serve request", err.message);
  }
});

const wss = new WebSocketServer({ server });
const clients = new Set<WebSocket>();
wss.on("connection", (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
});

const PATCH_FONTS = "patch_katex_fonts.py";

const watcher = chokidar.watch(["templates", "static", "filters", "build", PATCH_FONTS, DEFAULTS, IN_DIR], {
  ignored: (p) => path.basename(p).startsWith("."),
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: true,
  atomic: true,
});

let rebuildTimeout: NodeJS.Timeout | undefined, controller: AbortController | undefined;
let changed: Change[] = [];

function onChange({ path: changedPath, kind }: Change) {
  clearTimeout(rebuildTimeout);
  controller?.abort();

  rebuildTimeout = setTimeout(async () => {
    if (changedPath.startsWith("static/")) {
      const target = `${OUT_DIR}/.assets/${changedPath.replace(/^static\//, "")}`;
      if (kind === "D") {
        await unlink(target);
      } else {
        await copyFile(changedPath, target);
      }
      clients.forEach((c) => c.send("reload"));
      return;
    }

    const inDir = changedPath.startsWith(IN_DIR);
    if (inDir) {
      changedPath = changedPath.replace(IN_DIR + "/", "");
      const existing = changed.find((c) => c.path === changedPath);
      if (existing) {
        existing.kind = kind;
      } else {
        changed.push({ path: changedPath, kind });
      }
    }

    console.info(`Rebuilding ${changedPath} . . .`);

    controller = new AbortController();
    if (await build(controller.signal, changed, !inDir)) {
      changed = [];
    }

    clients.forEach((c) => c.send("reload"));
  }, 150);
}

console.info("Building . . .");
if (!(await build(undefined, undefined, true))) process.exit(1);

watcher
  .on("add", (path) => onChange({ path, kind: "A" }))
  .on("change", (path) => onChange({ path, kind: "M" }))
  .on("unlink", (path) => onChange({ path, kind: "D" }))
  .on("error", (err) => console.error("Watcher error:", err));

const auth = startAuthProxy();
auth.on("error", (err) => {
  console.error("Start auth proxy:", err);
});

process.on("SIGINT", (signal) => {
  controller?.abort();
  process.kill(-auth.pid!, signal);
  process.exit();
});

server.listen(PORT, () => console.info(`Server running at http://localhost:${PORT}`));
