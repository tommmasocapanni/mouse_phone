const https = require("https");
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execSync } = require("child_process");
const { WebSocketServer } = require("ws");
const QRCode = require("qrcode");

const PORT = Number(process.env.PORT || 8443);
const CA_PORT = Number(process.env.CA_PORT || 8080);
const ROOT = __dirname;
const PUB = path.join(ROOT, "public");
const CERTS = path.join(ROOT, "certs");
const HELPER = path.join(ROOT, "cursor", "cursor_helper");
const HOSTNAME = os.hostname();

function lanAddresses() {
  const out = [];
  for (const [, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal) out.push(a.address);
    }
  }
  return out;
}

function bonjourName() {
  try {
    const name = execSync("scutil --get LocalHostName", { encoding: "utf8" }).trim();
    if (name) return name;
  } catch (_) {}
  return HOSTNAME.split(".")[0];
}

const LAN_IP = lanAddresses()[0] || "127.0.0.1";
const BONJOUR = bonjourName();
const JOIN_URL = `https://${LAN_IP}:${PORT}`;
const LOCAL_URL = `https://${BONJOUR}.local:${PORT}`;

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
div{text-align:center}img{width:min(72vmin,360px)}p{font-size:11px;letter-spacing:.14em;color:#888;margin-top:18px}small{font-size:9px;color:#bbb}a{color:#191919}</style>
</head><body><div><img src="${dataURL}" alt="QR"><p>SCANSANA CON L'IPHONE</p><small><a href="${JOIN_URL}">${JOIN_URL}</a></small><br><small>${LOCAL_URL}</small></div></body></html>`;
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
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(full)] || "application/octet-stream",
        "Cache-Control": "no-store, must-revalidate",
      });
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

// heartbeat: chiude i socket "zombie" che iOS lascia aperti a livello applicativo
// ma sono morti a livello di rete.
const PING_MS = 25000;
const heartbeat = setInterval(() => {
  for (const c of wss.clients) {
    if (c.isAlive === false) {
      try { c.terminate(); } catch (_) {}
      continue;
    }
    c.isAlive = false;
    try { c.ping(); } catch (_) {}
  }
}, PING_MS);
wss.on("close", () => clearInterval(heartbeat));

function broadcastStatus() {
  const data = JSON.stringify({
    type: "status",
    trusted: helperTrusted,
    display: helperDisplay,
    hostname: BONJOUR,
  });
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
}

const MEDIA_KEYS = ["volup", "voldown", "mute", "play", "next", "prev"];

wss.on("connection", (ws, req) => {
  const ip = (req.socket.remoteAddress || "?").replace("::ffff:", "");
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.send(JSON.stringify({
    type: "status",
    trusted: helperTrusted,
    display: helperDisplay,
    hostname: BONJOUR,
  }));
  console.log(`client connesso da ${ip}`);
  ws.on("close", (code, reason) => {
    const why = reason && reason.length ? `, "${reason.toString()}"` : "";
    console.log(`client disconnesso da ${ip} (code ${code}${why})`);
  });
  ws.on("error", (err) => {
    console.log(`client error da ${ip}: ${err.message}`);
  });
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (_) {
      return;
    }
    switch (msg.type) {
      case "ping":
        ws.send(JSON.stringify({ type: "pong" }));
        break;
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

// --- server HTTP per installare la CA (una tantum sull'iPhone) ---
const CA_PATH = path.join(CERTS, "rootCA.pem");

function mobileConfig(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const uuid = () => crypto.randomUUID().toUpperCase();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key><string>rootCA.pem</string>
      <key>PayloadContent</key><data>${b64}</data>
      <key>PayloadDescription</key><string>CA locale per mouse_phone</string>
      <key>PayloadDisplayName</key><string>mouse_phone Local CA</string>
      <key>PayloadIdentifier</key><string>local.mousephone.rootca</string>
      <key>PayloadType</key><string>com.apple.security.root</string>
      <key>PayloadUUID</key><string>${uuid()}</string>
      <key>PayloadVersion</key><integer>1</integer>
    </dict>
  </array>
  <key>PayloadDisplayName</key><string>mouse_phone Local CA</string>
  <key>PayloadIdentifier</key><string>local.mousephone.profile</string>
  <key>PayloadRemovalDisallowed</key><false/>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>${uuid()}</string>
  <key>PayloadVersion</key><integer>1</integer>
</dict>
</plist>`;
}

function startCaServer() {
  if (!fs.existsSync(CA_PATH)) return;
  const caPem = fs.readFileSync(CA_PATH, "utf8");
  const caServer = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/ca.mobileconfig") {
      res.writeHead(200, { "Content-Type": "application/x-apple-aspen-config" });
      res.end(mobileConfig(caPem));
      return;
    }
    if (url.pathname === "/ca.pem") {
      res.writeHead(200, { "Content-Type": "application/x-x509-ca-cert" });
      res.end(caPem);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>mouse_phone — CA</title>
<style>body{font-family:ui-monospace,monospace;background:#fbfbfa;color:#191919;max-width:520px;margin:0 auto;padding:32px 22px;line-height:1.7}
h1{font-size:20px;letter-spacing:-.06em}a.btn{display:block;text-align:center;background:#1d1d1d;color:#fff;text-decoration:none;padding:15px;border-radius:12px;margin:14px 0;font-size:12px;letter-spacing:.08em}
ol{padding-left:20px;font-size:12px;color:#555}code{background:#eee;padding:1px 5px;border-radius:4px}</style>
</head><body>
<h1>dot. — installa la CA</h1>
<p>Per far funzionare HTTPS e WebSocket su iOS serve una CA fidata (una volta sola).</p>
<a class="btn" href="/ca.mobileconfig">1 · INSTALLA IL PROFILO</a>
<ol>
  <li>Impostazioni → <b>Profilo scaricato</b> → Installa (passcode) → Installa.</li>
  <li>Impostazioni → Generali → Info → <b>Impostazioni attendibilità certificati</b>.</li>
  <li>Attiva l'interruttore per <b>mouse_phone Local CA</b> → Continua.</li>
  <li>Torna su <code>${JOIN_URL}</code> e ricarica.</li>
</ol>
<p><small>Alternativa: <a href="/ca.pem">scarica rootCA.pem</a> (AirDrop).</small></p>
</body></html>`);
  });
  caServer.on("error", (err) => console.log(`CA server (${CA_PORT}): ${err.message}`));
  caServer.listen(CA_PORT, () => {
    console.log(`  CA:      http://${LAN_IP}:${CA_PORT}/ca   (installazione sul telefono)`);
  });
}

// --- avvio ---
server.listen(PORT, async () => {
  console.log("dot. remote trackpad in ascolto:");
  console.log(`  Mac:     https://localhost:${PORT}`);
  console.log(`  join:    ${JOIN_URL}`);
  console.log(`  iPhone:  ${LOCAL_URL}   (mDNS / Bonjour)`);
  console.log(`  QR:      https://localhost:${PORT}/qr`);
  startCaServer();
  try {
    console.log("\n" + (await QRCode.toString(JOIN_URL, { type: "terminal", small: true })) + "\n");
  } catch (_) {}
});
