const https = require("https");
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execSync, execFile } = require("child_process");
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

// --- persistenza (file JSON in data/) ---
const DATA = path.join(ROOT, "data");
fs.mkdirSync(DATA, { recursive: true });

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, file), "utf8"));
  } catch (_) {
    return fallback;
  }
}

// scrittura atomica: tmp + rename, così un crash non corrompe il file.
function writeJson(file, value) {
  const target = path.join(DATA, file);
  const tmp = target + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, target);
}

// impostazioni: token di pairing (generato al primo avvio), browser,
// display di destinazione, cartella film, player.
const settings = Object.assign(
  {
    token: crypto.randomBytes(24).toString("hex"),
    browser: "default",
    displayIndex: null,
    moviesRoot: path.join(os.homedir(), "Movies"),
    player: "auto",
  },
  readJson("settings.json", {})
);
// se il browser salvato non è più installato, torna al browser di sistema
if (!installedBrowsers().includes(settings.browser)) settings.browser = "default";
writeJson("settings.json", settings);

const DEFAULT_BOOKMARKS = [
  { id: "youtube", name: "YouTube", url: "https://www.youtube.com", icon: "▶" },
  { id: "netflix", name: "Netflix", url: "https://www.netflix.com", icon: "N" },
  { id: "plex", name: "Plex", url: "https://app.plex.tv", icon: "P" },
];
let bookmarks = readJson("bookmarks.json", null);
if (!Array.isArray(bookmarks)) {
  bookmarks = DEFAULT_BOOKMARKS.map((b) => ({ ...b }));
  writeJson("bookmarks.json", bookmarks);
}

// coda di link (usata da /api/cast mode=queue e dalla view Cinema nello step 6)
let queue = readJson("queue.json", null);
if (!Array.isArray(queue)) {
  queue = [];
  writeJson("queue.json", queue);
}

// stato di navigazione del player: la coda è la playlist ordinata, "index" indica
// quale elemento è in riproduzione (-1 = niente della coda / elemento esterno).
// Non persistito: al riavvio del server si riparte pulito.
let playNav = { current: null, index: -1 };

// apre un link della coda nel browser configurato, riusando la tab attiva così
// il video precedente non resta in riproduzione dietro a quello nuovo
async function openQueueItem(item) {
  await helperCall({
    cmd: "openurl",
    url: item.url,
    browser: settings.browser,
    displayIndex: settings.displayIndex,
    fullscreen: true,
    reuseTab: true,
  });
}

// sposta il cursore della coda sull'elemento i e lo apre nel browser
async function playQueueAt(i) {
  const item = queue[i];
  if (!item) return null;
  playNav.index = i;
  playNav.current = item;
  writeJson("queue.json", queue);
  broadcast({ type: "queue", queue, index: i });
  await openQueueItem(item);
  return item;
}

// browser rilevati sul Mac. "default" apre con il browser di sistema di macOS.
function installedBrowsers() {
  const candidates = [
    ["chrome", "/Applications/Google Chrome.app"],
    ["arc", "/Applications/Arc.app"],
    ["brave", "/Applications/Brave Browser.app"],
    ["edge", "/Applications/Microsoft Edge.app"],
    ["firefox", "/Applications/Firefox.app"],
  ];
  const list = ["default"];
  for (const [id, app] of candidates) {
    if (fs.existsSync(app)) list.push(id);
  }
  list.push("safari");
  return list;
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

    // --- canale realtime via HTTP (nessuna WebSocket: in WKWebView la WSS
    //     valida il certificato con un percorso separato che fallisce con CA
    //     locale; fetch/EventSource usano lo stesso percorso dei file statici) ---
    if (url.pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(": ok\n\n");
      sendSse(res, { type: "status", trusted: helperTrusted, display: helperDisplay, hostname: BONJOUR });
      sseClients.add(res);
      const keep = setInterval(() => {
        try { res.write(": keepalive\n\n"); } catch (_) {}
      }, 15000);
      const ip = (req.socket.remoteAddress || "?").replace("::ffff:", "");
      console.log(`client SSE connesso da ${ip}`);
      req.on("close", () => {
        clearInterval(keep);
        sseClients.delete(res);
        console.log(`client SSE disconnesso da ${ip}`);
      });
      return;
    }

    if (url.pathname === "/api/input" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => {
        body += c;
        if (body.length > 1e6) req.destroy();
      });
      req.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch (_) {
          res.writeHead(400).end("bad json");
          return;
        }
        const msgs = Array.isArray(parsed) ? parsed : [parsed];
        for (const msg of msgs) handleMessage(msg);
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end('{"ok":true}');
      });
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      handleApi(req, res, url);
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
      // inietta il token di pairing nella pagina: il client lo usa come Bearer.
      let out = data;
      if (file === "/index.html") {
        out = Buffer.from(data.toString("utf8").replace(/__PAIR_TOKEN__/g, settings.token));
      }
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(full)] || "application/octet-stream",
        "Cache-Control": "no-store, must-revalidate",
      });
      res.end(out);
    });
  }
);

// SSE: il flusso resta aperto a lungo, niente timeout di richiesta.
server.requestTimeout = 0;
server.headersTimeout = 60000;
server.keepAliveTimeout = 120000;

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
        if (msg.type === "reply") {
          const pending = helperPending.get(msg.id);
          if (pending) {
            helperPending.delete(msg.id);
            if (msg.ok) pending.resolve(msg);
            else pending.reject(new Error(msg.error || msg.result || "errore helper"));
          }
          continue;
        }
        if (msg.type === "helper") {
          helperTrusted = !!msg.trusted;
          helperDisplay = msg.display || null;
          helperDisplays = Array.isArray(msg.displays) ? msg.displays : helperDisplays;
          broadcastStatus();
          broadcast({ type: "displays", displays: helperDisplays, target: settings.displayIndex });
          if (!helperTrusted) {
            console.log("⚠️  Concedi il permesso Accessibilità al terminale, poi riavvia con `npm start`");
          }
        } else if (msg.type === "gestureDiagnostic") {
          console.log(`Mission Control: ${msg.method || "unknown"}`);
          broadcast({ type: "gestureDiagnostic", action: msg.action, method: msg.method });
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

// --- chiamate helper con richiesta/risposta (id) ---
let helperDisplays = [];
let helperSeq = 0;
const helperPending = new Map();

function helperCall(cmd, timeout = 5000) {
  return new Promise((resolve, reject) => {
    if (!helper || !helper.stdin.writable) return reject(new Error("helper non disponibile"));
    const id = ++helperSeq;
    helperPending.set(id, { resolve, reject });
    sendHelper(Object.assign({ id }, cmd));
    setTimeout(() => {
      if (helperPending.has(id)) {
        helperPending.delete(id);
        reject(new Error("timeout helper"));
      }
    }, timeout);
  });
}

// --- utilità HTTP/API ---
function readBody(req, limit = 2e6) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > limit) {
        reject(new Error("body troppo grande"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function jsonResponse(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function isAuthed(req, url) {
  const header = req.headers["authorization"] || "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  const token = (m ? m[1] : url.searchParams.get("token") || "").trim();
  return token.length > 0 && token === settings.token;
}

// rate limit molto semplice in memoria, per IP.
const rateBuckets = new Map();
function rateLimited(key, max = 40, windowMs = 10000) {
  const now = Date.now();
  const arr = (rateBuckets.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  rateBuckets.set(key, arr);
  return arr.length > max;
}

// accetta solo URL http(s); restituisce la stringa normalizzata o null.
function safeUrl(raw) {
  try {
    const u = new URL(String(raw || "").trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch (_) {
    return null;
  }
}

// --- YouTube: riconosce i video e importa le playlist nella coda ---
function youTubeInfo(raw) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch (_) { return null; }
  const host = u.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
  if (host !== "youtube.com" && host !== "youtu.be" && host !== "music.youtube.com") return null;
  let videoId = u.searchParams.get("v") || "";
  if (!videoId && host === "youtu.be") videoId = u.pathname.replace(/^\/+/, "").split("/")[0];
  if (!videoId) {
    const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
    if (m) videoId = m[1];
  }
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) videoId = "";
  return { videoId, listId: u.searchParams.get("list") || "" };
}

function youTubeSingleUrl(videoId) {
  return "https://www.youtube.com/watch?v=" + videoId;
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

function httpsGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return httpsGet(new URL(res.headers.location, url).toString(), timeoutMs).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error("HTTP " + res.statusCode)); }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { data += c; if (data.length > 8 * 1024 * 1024) req.destroy(new Error("troppo grande")); });
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs || 12000, () => req.destroy(new Error("timeout")));
  });
}

// nuova UI YouTube: blocchi "lockupViewModel" con titolo + contentId (= videoId)
function parsePlaylistHtml(html) {
  const out = [];
  const seen = new Set();
  const parts = html.split('"lockupViewModel":{');
  for (let k = 1; k < parts.length; k++) {
    const block = parts[k];
    const t = block.match(/"lockupMetadataViewModel":\{"title":\{"content":"((?:[^"\\]|\\.)*)"/);
    const c = block.match(/"contentId":"([A-Za-z0-9_-]{11})"/);
    if (t && c && !seen.has(c[1])) {
      seen.add(c[1]);
      out.push({ videoId: c[1], title: decodeEntities(t[1]) });
    }
  }
  return out;
}

function parsePlaylistRss(xml) {
  const out = [];
  for (const e of String(xml).split("<entry>").slice(1)) {
    const v = e.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
    const t = e.match(/<title>([^<]*)<\/title>/);
    if (v && /^[A-Za-z0-9_-]{11}$/.test(v[1])) out.push({ videoId: v[1], title: decodeEntities(t ? t[1] : "") });
  }
  return out;
}

// elenco video di una playlist: prima la pagina (fino a 100 in ordine), poi il feed RSS (~15).
async function fetchYouTubePlaylist(listId) {
  if (!/^[A-Za-z0-9_-]{10,}$/.test(listId)) return [];
  try {
    const html = await httpsGet("https://www.youtube.com/playlist?list=" + encodeURIComponent(listId) + "&hl=en");
    const items = parsePlaylistHtml(html);
    if (items.length) return items.slice(0, 100);
  } catch (_) {}
  try {
    const xml = await httpsGet("https://www.youtube.com/feeds/videos.xml?playlist_id=" + encodeURIComponent(listId));
    return parsePlaylistRss(xml).slice(0, 100);
  } catch (_) {}
  return [];
}

function newQueueItem(url, title) {
  return { id: "q_" + crypto.randomBytes(4).toString("hex"), url, title: title || null, addedAt: Date.now() };
}

// la playlist diventa la nostra coda: i video successivi a quello in riproduzione
// la playlist diventa la nostra coda: TUTTI i video finiscono nell'elenco e
// "index" punta al video che sta suonando (o -1 se non è nella playlist).
function applyPlaylistItems(items, currentVideoId) {
  let idx = -1;
  queue = items.map((x, i) => {
    if (currentVideoId && x.videoId === currentVideoId) idx = i;
    return newQueueItem(youTubeSingleUrl(x.videoId), x.title);
  });
  playNav.index = idx;
  if (idx >= 0) playNav.current = queue[idx];
  writeJson("queue.json", queue);
  broadcast({ type: "queue", queue, index: playNav.index, autoplay: queue.length > 1 });
  console.log(`playlist: ${queue.length} video in coda (indice ${playNav.index})`);
}

// apre un URL: se è una playlist YouTube la scarica, apre il singolo video scelto
// (quello indicato o il primo) e mette l'intera playlist nella coda.
async function openUrlSmart(clean, reuseTab) {
  const info = youTubeInfo(clean);
  const base = { cmd: "openurl", browser: settings.browser, displayIndex: settings.displayIndex, fullscreen: true };
  if (reuseTab) base.reuseTab = true;
  let target = clean;
  let items = null;
  let idx = -1;
  if (info && info.listId) {
    items = await fetchYouTubePlaylist(info.listId).catch(() => []);
    if (items && items.length) {
      idx = info.videoId ? items.findIndex((x) => x.videoId === info.videoId) : 0;
      if (idx < 0) idx = 0;
      target = youTubeSingleUrl(items[idx].videoId);
    } else if (info.videoId) {
      target = youTubeSingleUrl(info.videoId);
      items = null;
    }
  } else if (info && info.videoId) {
    target = youTubeSingleUrl(info.videoId);
  }
  base.url = target;
  await helperCall(base);
  playNav.index = -1;
  playNav.current = { id: null, url: target, title: null };
  if (items && items.length) applyPlaylistItems(items, idx >= 0 ? items[idx].videoId : "");
}

function publicSettings() {
  return {
    browser: settings.browser,
    displayIndex: settings.displayIndex,
    moviesRoot: settings.moviesRoot,
    player: settings.player,
    browsers: installedBrowsers(),
  };
}

// --- controllo del player web tramite iniezione JS (helper execjs) ---
const JS_MEDIA = "document.querySelector('video')||document.querySelector('audio')";
const JS_NOWPLAYING =
  "(function(){try{var v=" + JS_MEDIA + ";if(!v)return '{\"found\":false}';" +
  "var t=String(document.title||'').slice(0,180);" +
  "var cur=isFinite(v.currentTime)?v.currentTime:0;" +
  "var dur=isFinite(v.duration)?v.duration:0;" +
  "var art='';try{art=v.poster||'';}catch(e){}" +
  "if(!art){var mm=document.querySelector('meta[property=\"og:image\"],meta[name=\"og:image\"]');if(mm&&mm.content)art=mm.content;}" +
  "if(art){try{art=new URL(art,location.href).href;}catch(e){art='';}}" +
  "return JSON.stringify({found:true,title:t,current:cur,duration:dur,paused:!!v.paused,ended:!!v.ended,rate:v.playbackRate||1,url:String(location.href||'').slice(0,200),art:String(art||''),site:String(location.hostname||'')});" +
  "}catch(e){return JSON.stringify({found:false,error:String(e)});}})()";

// salta intro/ads: clicca i pulsanti noti (click realistico), poi euristica testuale,
// e COMUNQUE manda avanti l'ad se è in corso (YouTube blocca i click sintetici)
const JS_SKIP = [
  "(function(){try{",
  "function vis(el){if(!el)return false;var r=el.getBoundingClientRect();var s=getComputedStyle(el);return r.width>1&&r.height>1&&s.visibility!=='hidden'&&s.display!=='none'&&s.opacity!=='0';}",
  "function realClick(el){try{var r=el.getBoundingClientRect();var o={bubbles:true,cancelable:true,view:window,clientX:r.left+r.width/2,clientY:r.top+r.height/2};el.dispatchEvent(new MouseEvent('mousedown',o));el.dispatchEvent(new MouseEvent('mouseup',o));el.dispatchEvent(new MouseEvent('click',o));el.click();return true;}catch(e){try{el.click();return true;}catch(_){return false;}}}",
  "var sels=['.ytp-ad-skip-button-modern','.ytp-skip-ad-button','.ytp-ad-skip-button','.ytp-skip-ad-button-modern','.ytp-ad-skip-button-container button','.videoAdUiSkipButton','.ytp-button[aria-label*=\"Skip\"]','.ytp-ad-button[aria-label*=\"Skip\"]','button[aria-label^=\"Skip ad\"]','button[aria-label*=\"Salta\"]','[data-uia=\"player-skip-intro\"]','[data-uia=\"player-skip-recap\"]','.skip-button','.skip-intro','button[class*=\"skip\"]','[class*=\"skip\"][class*=\"intro\"]','.ytp-ad-overlay-close-button'];",
  "var clicked=null;",
  "for(var i=0;i<sels.length&&!clicked;i++){var els=document.querySelectorAll(sels[i]);for(var j=0;j<els.length;j++){if(vis(els[j])){realClick(els[j]);clicked=sels[i];break;}}}",
  "if(!clicked){var btns=document.querySelectorAll('button,[role=button]');for(var k=0;k<btns.length;k++){var t=(btns[k].textContent||'').trim().toLowerCase();if(t.length<=24&&/^(skip|salta|ignora|omite|pular|passer)/.test(t)&&!/navigation|content|menu/.test(t)&&vis(btns[k])){realClick(btns[k]);clicked='text:'+t.slice(0,24);break;}}}",
  "var host=document.querySelector('.html5-video-player,#movie_player');",
  "var inAd=(host&&host.classList&&(host.classList.contains('ad-showing')||host.classList.contains('ad-interrupting')))||!!document.querySelector('.ytp-ad-player-overlay,.ytp-ad-preview-container,.ytp-ad-simple-ad-badge');",
  "var v=document.querySelector('video');",
  "if(inAd&&v){try{v.playbackRate=16;if(isFinite(v.duration)&&v.duration>0){v.currentTime=Math.max(v.currentTime,v.duration-0.1);}window.__dotAdFF=true;setTimeout(function(){try{var vv=document.querySelector('video');if(vv)vv.playbackRate=1;}catch(e){}},6000);if(!clicked)clicked='ad-ff';}catch(e){}}",
  "else if(v&&window.__dotAdFF){try{v.playbackRate=1;}catch(e){}window.__dotAdFF=false;}",
  "return JSON.stringify({clicked:clicked,ad:!!inAd});",
  "}catch(e){return JSON.stringify({clicked:null,error:String(e)});}})()",
].join("");

function jsPlayer(action, seconds) {
  const find = "var v=" + JS_MEDIA + ";if(!v)return '0';";
  if (action === "seek")
    return "(function(){" + find + "v.currentTime=" + (Number(seconds) || 0) + ";return '1';})()";
  if (action === "seekrel")
    return "(function(){" + find + "var d=" + (Number(seconds) || 0) + ";var nd=v.currentTime+d;" +
      "if(isFinite(v.duration)&&v.duration>0){nd=Math.max(0,Math.min(v.duration,nd));}else{nd=Math.max(0,nd);}" +
      "v.currentTime=nd;return String(nd);})()";
  if (action === "play")
    return "(function(){" + find + "var p=v.play();if(p&&p.catch)p.catch(function(){});return '1';})()";
  if (action === "pause")
    return "(function(){" + find + "v.pause();return '1';})()";
  return "(function(){" + find + "if(v.paused){var p=v.play();if(p&&p.catch)p.catch(function(){});}else{v.pause();}return '1';})()";
}

async function runBrowserJS(js) {
  if (settings.browser === "default") {
    return { ok: false, reason: "no-browser", error: "seleziona un browser specifico (Safari/Chrome/Arc) nelle impostazioni" };
  }
  try {
    const rep = await helperCall({ cmd: "execjs", browser: settings.browser, js }, 6000);
    return { ok: true, result: String(rep.result == null ? "" : rep.result) };
  } catch (e) {
    const msg = String(e.message || "errore");
    const noPerm = /javascript|apple\s?events|non .*consentito|not allowed|privilege|non è consentito/i.test(msg);
    return { ok: false, reason: noPerm ? "permission" : "error", error: msg };
  }
}

const VIDEO_EXT = new Set([
  ".mp4", ".mkv", ".mov", ".m4v", ".avi", ".webm", ".flv",
  ".wmv", ".mpg", ".mpeg", ".ts", ".m2ts", ".ogv",
]);
// GET /api/files?path= — esplorazione della cartella film, confinata alla root.
function listFiles(url, res) {
  const root = path.resolve(settings.moviesRoot);
  const rel = url.searchParams.get("path") || "";
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(root + path.sep)) {
    return jsonResponse(res, 403, { error: "fuori dalla cartella consentita" });
  }
  let entries;
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch (_) {
    return jsonResponse(res, 404, { error: "cartella non accessibile" });
  }
  const items = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const abs = path.join(target, e.name);
    const item = { name: e.name, path: path.relative(root, abs), dir: e.isDirectory() };
    if (!e.isDirectory()) {
      try {
        item.size = fs.statSync(abs).size;
      } catch (_) {}
      item.video = VIDEO_EXT.has(path.extname(e.name).toLowerCase());
    }
    items.push(item);
  }
  items.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return jsonResponse(res, 200, {
    root,
    path: path.relative(root, target),
    items,
  });
}

// apre un file locale nel player scelto (IINA > VLC > QuickTime).
function launchPlayer(file, start, displayIndex) {
  const candidates = [
    { name: "iina", bin: "/Applications/IINA.app/Contents/MacOS/iina-cli" },
    { name: "vlc", bin: "/Applications/VLC.app/Contents/MacOS/VLC" },
  ];
  const wanted = settings.player && settings.player !== "auto" ? settings.player : null;
  for (const c of candidates) {
    if (wanted && wanted !== c.name) continue;
    if (!fs.existsSync(c.bin)) continue;
    // IINA: iina-cli --mpv-start=<s> ; VLC: --start-time=<s>. Niente shell:
    // argomenti passati direttamente a spawn.
    const args = c.name === "iina"
      ? ["--no-stdin", `--mpv-start=${start}`, "--mpv-fullscreen", `--mpv-screen=${displayIndex ?? 0}`, file]
      : [`--start-time=${start}`, "--fullscreen", `--qt-fullscreen-screennumber=${displayIndex ?? 0}`, file];
    try {
      spawn(c.bin, args, { detached: true, stdio: "ignore" }).unref();
      return c.name;
    } catch (_) {}
  }
  if (wanted && wanted !== "quicktime") return null;
  try {
    spawn("open", ["-a", "QuickTime Player", file], { detached: true, stdio: "ignore" }).unref();
    return "quicktime";
  } catch (_) {
    return null;
  }
}

// scarica la favicon di un sito e la restituisce come data URI (tetto 100KB).
async function fetchFavicon(rawUrl) {
  const u = safeUrl(rawUrl);
  if (!u) return "";
  try {
    const origin = new URL(u).origin;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const resp = await fetch(origin + "/favicon.ico", { signal: ctrl.signal, redirect: "follow" });
    clearTimeout(timer);
    if (!resp.ok) return "";
    const type = resp.headers.get("content-type") || "image/x-icon";
    if (!/^image\//.test(type)) return "";
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length === 0 || buf.length > 100 * 1024) return "";
    return `data:${type};base64,${buf.toString("base64")}`;
  } catch (_) {
    return "";
  }
}

async function handleApi(req, res, url) {
  const ip = (req.socket.remoteAddress || "?").replace("::ffff:", "");
  if (rateLimited(ip)) return jsonResponse(res, 429, { error: "troppe richieste" });
  if (!isAuthed(req, url)) return jsonResponse(res, 401, { error: "token mancante o errato" });

  const p = url.pathname;
  const method = req.method;

  try {
    if (p === "/api/settings" && method === "GET") {
      return jsonResponse(res, 200, publicSettings());
    }
    if (p === "/api/settings" && method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}");
      if (typeof b.browser === "string" && installedBrowsers().includes(b.browser)) settings.browser = b.browser;
      if (b.displayIndex === null || Number.isInteger(b.displayIndex)) settings.displayIndex = b.displayIndex;
      if (typeof b.moviesRoot === "string" && b.moviesRoot.trim()) settings.moviesRoot = path.resolve(b.moviesRoot.trim());
      if (typeof b.player === "string") settings.player = b.player;
      writeJson("settings.json", settings);
      broadcast({ type: "settings", settings: publicSettings() });
      return jsonResponse(res, 200, publicSettings());
    }
    if (p === "/api/displays" && method === "GET") {
      let displays = helperDisplays;
      try {
        const rep = await helperCall({ cmd: "displays" });
        if (Array.isArray(rep.data)) displays = rep.data;
      } catch (_) {}
      return jsonResponse(res, 200, { displays, target: settings.displayIndex });
    }
    if (p === "/api/bookmarks" && method === "GET") {
      return jsonResponse(res, 200, { bookmarks });
    }
    if (p === "/api/bookmarks" && method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const clean = safeUrl(b.url);
      if (!b.name || !clean) return jsonResponse(res, 400, { error: "nome e url http(s) richiesti" });
      const bm = {
        id: "bm_" + crypto.randomBytes(4).toString("hex"),
        name: String(b.name).trim().slice(0, 40),
        url: clean,
        icon: typeof b.icon === "string" ? b.icon.slice(0, 400000) : "",
      };
      bookmarks.push(bm);
      writeJson("bookmarks.json", bookmarks);
      broadcast({ type: "bookmarks", bookmarks });
      return jsonResponse(res, 200, { bookmark: bm, bookmarks });
    }
    const bmMatch = p.match(/^\/api\/bookmarks\/([A-Za-z0-9_]+)$/);
    if (bmMatch) {
      const idx = bookmarks.findIndex((x) => x.id === bmMatch[1]);
      if (idx < 0) return jsonResponse(res, 404, { error: "bookmark non trovato" });
      if (method === "PATCH" || method === "PUT") {
        const b = JSON.parse((await readBody(req)) || "{}");
        if (typeof b.name === "string" && b.name.trim()) bookmarks[idx].name = b.name.trim().slice(0, 40);
        if (typeof b.url === "string") {
          const clean = safeUrl(b.url);
          if (clean) bookmarks[idx].url = clean;
        }
        if (typeof b.icon === "string") bookmarks[idx].icon = b.icon.slice(0, 400000);
        writeJson("bookmarks.json", bookmarks);
        broadcast({ type: "bookmarks", bookmarks });
        return jsonResponse(res, 200, { bookmarks });
      }
      if (method === "DELETE") {
        bookmarks.splice(idx, 1);
        writeJson("bookmarks.json", bookmarks);
        broadcast({ type: "bookmarks", bookmarks });
        return jsonResponse(res, 200, { bookmarks });
      }
    }
    if (p === "/api/bookmarks/reorder" && method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}");
      if (Array.isArray(b.order)) {
        const map = new Map(bookmarks.map((x) => [x.id, x]));
        const ordered = b.order.map((id) => map.get(id)).filter(Boolean);
        for (const x of bookmarks) if (!b.order.includes(x.id)) ordered.push(x);
        bookmarks = ordered;
        writeJson("bookmarks.json", bookmarks);
        broadcast({ type: "bookmarks", bookmarks });
      }
      return jsonResponse(res, 200, { bookmarks });
    }
    if (p === "/api/open" && method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const clean = safeUrl(b.url);
      if (!clean) return jsonResponse(res, 400, { error: "url non valido (http/https)" });
      await openUrlSmart(clean, false);
      return jsonResponse(res, 200, { ok: true });
    }
    if (p === "/api/cast" && method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const clean = safeUrl(b.url);
      if (!clean) return jsonResponse(res, 400, { error: "url non valido (http/https)" });
      if (b.mode === "queue") {
        // una playlist diventa tanti elementi singoli in coda (non un solo link)
        const info = youTubeInfo(clean);
        let added = 0;
        if (info && info.listId) {
          const items = await fetchYouTubePlaylist(info.listId).catch(() => []);
          for (const it of items) { queue.push(newQueueItem(youTubeSingleUrl(it.videoId), it.title)); added++; }
        }
        if (!added) { queue.push(newQueueItem(clean, null)); added = 1; }
        writeJson("queue.json", queue);
        broadcast({ type: "queue", queue, index: playNav.index });
        return jsonResponse(res, 200, { ok: true, mode: "queue", added });
      }
      await openUrlSmart(clean, false);
      return jsonResponse(res, 200, { ok: true, mode: "open" });
    }
    if (p === "/api/queue" && method === "GET") {
      return jsonResponse(res, 200, { queue, index: playNav.index });
    }
    if (p === "/api/queue/remove" && method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const id = String(b.id || "");
      const i = queue.findIndex((q) => q.id === id);
      if (i < 0) return jsonResponse(res, 404, { error: "elemento non trovato" });
      queue.splice(i, 1);
      if (playNav.index === i) playNav.index = -1;
      else if (playNav.index > i) playNav.index--;
      writeJson("queue.json", queue);
      broadcast({ type: "queue", queue, index: playNav.index });
      return jsonResponse(res, 200, { ok: true, queue, index: playNav.index });
    }
    if (p === "/api/queue/move" && method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const id = String(b.id || "");
      const dir = b.dir === "up" ? -1 : b.dir === "down" ? 1 : 0;
      const i = queue.findIndex((q) => q.id === id);
      if (i < 0) return jsonResponse(res, 404, { error: "elemento non trovato" });
      const j = i + dir;
      if (dir !== 0 && j >= 0 && j < queue.length) {
        const tmp = queue[i];
        queue[i] = queue[j];
        queue[j] = tmp;
        if (playNav.index === i) playNav.index = j;
        else if (playNav.index === j) playNav.index = i;
        writeJson("queue.json", queue);
        broadcast({ type: "queue", queue, index: playNav.index });
      }
      return jsonResponse(res, 200, { ok: true, queue, index: playNav.index });
    }
    if (p === "/api/queue/next" && method === "POST") {
      const i = playNav.index >= 0 ? playNav.index + 1 : 0;
      const item = await playQueueAt(i);
      if (!item) return jsonResponse(res, 404, { error: playNav.index >= 0 ? "fine coda" : "coda vuota" });
      return jsonResponse(res, 200, { ok: true, opened: item, queue, index: playNav.index });
    }
    if (p === "/api/queue/prev" && method === "POST") {
      if (playNav.index <= 0) return jsonResponse(res, 404, { error: "nessun precedente" });
      const item = await playQueueAt(playNav.index - 1);
      if (!item) return jsonResponse(res, 404, { error: "nessun precedente" });
      return jsonResponse(res, 200, { ok: true, opened: item, queue, index: playNav.index });
    }
    if (p === "/api/queue/play" && method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const id = String(b.id || "");
      const i = queue.findIndex((q) => q.id === id);
      if (i < 0) return jsonResponse(res, 404, { error: "elemento non trovato" });
      const item = await playQueueAt(i);
      return jsonResponse(res, 200, { ok: true, opened: item, queue, index: playNav.index });
    }
    if (p === "/api/queue/clear" && method === "POST") {
      queue = [];
      playNav.index = -1;
      playNav.current = null;
      writeJson("queue.json", queue);
      broadcast({ type: "queue", queue, index: -1 });
      return jsonResponse(res, 200, { ok: true, queue, index: -1 });
    }
    if (p === "/api/nowplaying" && method === "GET") {
      const r = await runBrowserJS(JS_NOWPLAYING);
      if (!r.ok) {
        return jsonResponse(res, 200, { found: false, reason: r.reason, error: r.error, browser: settings.browser });
      }
      let data;
      const raw = String(r.result || "").trim();
      if (!raw) {
        data = { found: false, reason: "no-window" };
      } else {
        try {
          data = JSON.parse(raw);
        } catch (_) {
          const noPerm = /not allowed|consentito|privilege/i.test(raw);
          data = { found: false, reason: noPerm ? "permission" : "parse", error: raw };
        }
      }
      data.browser = settings.browser;
      return jsonResponse(res, 200, data);
    }
    if (p === "/api/player" && method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const action = ["play", "pause", "toggle"].includes(b.action) ? b.action : "toggle";
      const r = await runBrowserJS(jsPlayer(action));
      if (!r.ok) return jsonResponse(res, 200, { ok: false, reason: r.reason, error: r.error });
      return jsonResponse(res, 200, { ok: true, action, hit: r.result === "1" });
    }
    if (p === "/api/seek" && method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}");
      if (b.delta != null) {
        let d = Number(b.delta);
        if (!isFinite(d)) return jsonResponse(res, 400, { error: "delta non valido" });
        d = Math.max(-600, Math.min(600, d));
        const rr = await runBrowserJS(jsPlayer("seekrel", d));
        if (!rr.ok) return jsonResponse(res, 200, { ok: false, reason: rr.reason, error: rr.error });
        const pos = Number(rr.result);
        return jsonResponse(res, 200, { ok: true, delta: d, position: isFinite(pos) ? pos : null });
      }
      let sec = Number(b.seconds);
      if (!isFinite(sec) || sec < 0) return jsonResponse(res, 400, { error: "seconds non valido" });
      sec = Math.min(sec, 12 * 3600);
      const r = await runBrowserJS(jsPlayer("seek", sec));
      if (!r.ok) return jsonResponse(res, 200, { ok: false, reason: r.reason, error: r.error });
      return jsonResponse(res, 200, { ok: true, hit: r.result === "1" });
    }
    if (p === "/api/skip" && method === "POST") {
      const r = await runBrowserJS(JS_SKIP);
      if (!r.ok) return jsonResponse(res, 200, { ok: false, reason: r.reason, error: r.error });
      let out = { clicked: null, ad: false };
      try {
        out = JSON.parse(r.result);
      } catch (_) {}
      return jsonResponse(res, 200, { ok: true, clicked: out.clicked || null, ad: !!out.ad, error: out.error || null });
    }
    if (p === "/api/audio/devices" && method === "GET") {
      try {
        const rep = await helperCall({ cmd: "audiolist" });
        return jsonResponse(res, 200, { ok: true, devices: Array.isArray(rep.data) ? rep.data : [] });
      } catch (e) {
        return jsonResponse(res, 200, { ok: false, devices: [], error: e.message });
      }
    }
    if (p === "/api/audio/output" && method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const dev = Number(b.deviceId);
      if (!Number.isInteger(dev) || dev <= 0) return jsonResponse(res, 400, { error: "deviceId non valido" });
      try {
        await helperCall({ cmd: "audioset", deviceId: dev });
        return jsonResponse(res, 200, { ok: true, deviceId: dev });
      } catch (e) {
        return jsonResponse(res, 200, { ok: false, error: e.message });
      }
    }
    if (p === "/api/volume" && method === "GET") {
      try {
        const rep = await helperCall({ cmd: "volumeget" }, 4000);
        const v = Number(rep.volume);
        return jsonResponse(res, 200, { ok: v >= 0, volume: isFinite(v) && v >= 0 ? v : null });
      } catch (e) {
        return jsonResponse(res, 200, { ok: false, volume: null, error: e.message });
      }
    }
    if (p === "/api/volume" && method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const v = Number(b.volume);
      if (!isFinite(v)) return jsonResponse(res, 400, { error: "volume non valido" });
      const vol = Math.max(0, Math.min(100, Math.round(v)));
      try {
        await helperCall({ cmd: "volumeset", volume: vol }, 4000);
        return jsonResponse(res, 200, { ok: true, volume: vol });
      } catch (e) {
        return jsonResponse(res, 200, { ok: false, error: e.message });
      }
    }
    if (p === "/api/files" && method === "GET") {
      return listFiles(url, res);
    }
    if (p === "/api/play" && method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const root = path.resolve(settings.moviesRoot);
      const abs = path.resolve(root, String(b.path || ""));
      if (abs !== root && !abs.startsWith(root + path.sep)) {
        return jsonResponse(res, 403, { error: "fuori dalla cartella consentita" });
      }
      if (!fs.existsSync(abs)) return jsonResponse(res, 404, { error: "file non trovato" });
      const start = Math.max(0, Math.floor(Number(b.start) || 0));
      const player = launchPlayer(abs, start, settings.displayIndex);
      if (!player) return jsonResponse(res, 500, { error: "nessun player disponibile (IINA/VLC/QuickTime)" });
      // sposta la finestra del player sul display di destinazione
      setTimeout(() => {
        helperCall({ cmd: "movefront", displayIndex: settings.displayIndex, fullscreen: false }).catch(() => {});
      }, 1600);
      return jsonResponse(res, 200, { ok: true, player });
    }
    if (p === "/api/favicon" && method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const icon = await fetchFavicon(b.url);
      return jsonResponse(res, 200, { icon });
    }
    return jsonResponse(res, 404, { error: "endpoint sconosciuto" });
  } catch (err) {
    return jsonResponse(res, 500, { error: err.message });
  }
}

// --- messaggi (comuni a WebSocket e HTTP/SSE) ---
const MEDIA_KEYS = ["volup", "voldown", "mute", "play", "next", "prev"];

// Cambio scrivania: i tasti simbolici di sistema (Ctrl+←/→) NON vengono
// attivati dagli eventi CGEvent sintetici, quindi passiamo da System Events.
function switchSpace(dir) {
  const keyCode = dir === "left" ? 123 : 124;
  execFile(
    "/usr/bin/osascript",
    ["-e", `tell application "System Events" to key code ${keyCode} using control down`],
    (err) => { if (err) console.log(`space ${dir} error: ${err.message}`); }
  );
}

function handleMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "ping":
      break;
    case "move":
      sendHelper({ cmd: "move", x: msg.x, y: msg.y });
      break;
    case "click":
      sendHelper({ cmd: "click", button: msg.button === "right" ? "right" : "left" });
      break;
    case "doubleclick":
      sendHelper({ cmd: "doubleclick", button: msg.button === "right" ? "right" : "left" });
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
    case "space":
      if (msg.dir === "left" || msg.dir === "right") {
        switchSpace(msg.dir);
      }
      break;
    case "gesture":
      if (msg.action === "missionControl") {
        sendHelper({ cmd: "gesture", action: "missionControl" });
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
}

// --- WebSocket (mantenuto per compatibilità; il client usa SSE + fetch) ---
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

// --- client SSE + broadcast di stato ---
const sseClients = new Set();

function sendSse(res, obj) {
  try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (_) {}
}

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
  for (const res of sseClients) sendSse(res, obj);
}

function broadcastStatus() {
  broadcast({
    type: "status",
    trusted: helperTrusted,
    display: helperDisplay,
    hostname: BONJOUR,
  });
}

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
    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }
    handleMessage(msg);
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
