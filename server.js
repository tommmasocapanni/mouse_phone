const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { WebSocketServer } = require("ws");
const QRCode = require("qrcode");

const PORT = Number(process.env.PORT || 8443);
const ROOT = __dirname;
const PUB = path.join(ROOT, "public");
const CERTS = path.join(ROOT, "certs");
const HELPER = path.join(ROOT, "cursor", "cursor_helper");
const HOSTNAME = os.hostname();
const JOIN_URL = `https://${HOSTNAME}.local:${PORT}`;

if (!fs.existsSync(path.join(CERTS, "cert.pem")) || !fs.existsSync(path.join(CERTS, "key.pem"))) {
  console.error("Certificati mancanti: esegui `npm run certs`");
  process.exit(1);
}
if (!fs.existsSync(HELPER)) {
  console.error("Helper cursore mancante: esegui `npm run build`");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

const server = https.createServer(
  {
    cert: fs.readFileSync(path.join(CERTS, "cert.pem")),
    key: fs.readFileSync(path.join(CERTS, "key.pem")),
  },
  async (req, res) => {
    const url = new URL(req.url, "https://localhost");

    if (url.pathname === "/qr") {
      try {
        const dataURL = await QRCode.toDataURL(JOIN_URL, { margin: 1, width: 480 });
        const html = `<!doctype html><html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>dot. — join</title>
<style>body{font-family:ui-monospace,monospace;background:#fbfbfa;color:#191919;display:grid;place-items:center;min-height:100dvh;margin:0}
div{text-align:center}img{width:min(72vmin,360px)}p{font-size:11px;letter-spacing:.14em;color:#888;margin-top:18px}small{font-size:9px;color:#bbb}</style>
</head><body><div><img src="${dataURL}" alt="QR"><p>SCANSANA CON L'IPHONE</p><small>${JOIN_URL}</small></div></body></html>`;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      } catch (err) {
        res.writeHead(500).end("qr error");
      }
      return;
    }

    let file = url.pathname === "/" ? "/index.html" : url.pathname;
    const full = path.normalize(path.join(PUB, file));
    if (!full.startsWith(PUB)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(full, (err, data) => {
      if (err) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
      res.end(data);
    });
  }
);

// --- helper cursore (CGEvent) ---
let helper = null;
let helperTrusted = false;
let helperDisplay = null;
let lineBuf = "";

function startHelper() {
  helper = spawn(HELPER, [], { stdio: ["pipe", "pipe", "inherit"] });
  helper.stdout.setEncoding("utf8");
  helper.stdout.on("data", (chunk) => {
    lineBuf += chunk;
    let idx;
    while ((idx = lineBuf.indexOf("\n")) >= 0) {
      const line = lineBuf.slice(0, idx);
      lineBuf = lineBuf.slice(idx + 1);
      try {
        const msg = JSON.parse(line);
        if (msg.type === "helper") {
          helperTrusted = !!msg.trusted;
          helperDisplay = msg.display || null;
          broadcastStatus();
          if (!helperTrusted) {
            console.log("⚠️  Concedi il permesso Accessibilità al terminale, poi riavvia con `npm start`");
          }
        }
      } catch (_) {}
    }
  });
  helper.on("exit", (code) => {
    helper = null;
    broadcastStatus();
    if (code !== 0) {
      console.error(`Helper terminato (code ${code}), riavvio...`);
      setTimeout(startHelper, 1000);
    }
  });
}
startHelper();

function sendHelper(obj) {
  if (helper && helper.stdin.writable) {
    helper.stdin.write(JSON.stringify(obj) + "\n");
  }
}

// --- WebSocket ---
const wss = new WebSocketServer({ server });

function broadcastStatus() {
  const data = JSON.stringify({
    type: "status",
    trusted: helperTrusted,
    display: helperDisplay,
    hostname: HOSTNAME,
  });
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
}

const MEDIA_KEYS = ["volup", "voldown", "mute", "play", "next", "prev"];

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({
    type: "status",
    trusted: helperTrusted,
    display: helperDisplay,
    hostname: HOSTNAME,
  }));
  console.log("client connesso");
  ws.on("close", () => console.log("client disconnesso"));
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (_) {
      return;
    }
    switch (msg.type) {
      case "move":
        sendHelper({ cmd: "move", x: msg.x, y: msg.y });
        break;
      case "click":
        sendHelper({ cmd: "click", button: msg.button === "right" ? "right" : "left" });
        break;
      case "scroll":
        sendHelper({ cmd: "scroll", dx: Number(msg.dx) || 0, dy: Number(msg.dy) || 0 });
        break;
      case "text":
        if (typeof msg.text === "string" && msg.text.trim()) {
          sendHelper({ cmd: "text", text: msg.text.slice(0, 500) });
        }
        break;
      case "key":
        if (typeof msg.key === "string") {
          sendHelper({ cmd: "key", key: msg.key, command: !!msg.command });
        }
        break;
      case "media":
        if (MEDIA_KEYS.includes(msg.key)) {
          sendHelper({ cmd: "media", key: msg.key });
        }
        break;
      default:
        break;
    }
  });
});

// --- avvio ---
function lanAddresses() {
  const out = [];
  for (const [, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal) out.push(a.address);
    }
  }
  return out;
}

server.listen(PORT, async () => {
  console.log("dot. remote trackpad in ascolto:");
  console.log(`  Mac:     https://localhost:${PORT}`);
  console.log(`  join:    ${JOIN_URL}`);
  for (const ip of lanAddresses()) console.log(`  iPhone:  https://${ip}:${PORT}`);
  console.log(`  QR:      https://localhost:${PORT}/qr`);
  try {
    console.log("\n" + (await QRCode.toString(JOIN_URL, { type: "terminal", small: true })) + "\n");
  } catch (_) {}
});
