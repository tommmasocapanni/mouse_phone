(() => {
  "use strict";

  const DEG = Math.PI / 180;
  const BUILD = "v31";
  const GAIN_X = 1 / (2 * 50);
  const GAIN_Y = 1 / (2 * 40);
  const EMA = 0.32;
  const DEADZONE = 0.002;
  const LONG_PRESS_MS = 350;
  const CAL_HOLD_MS = 3000;
  const TAP_DIST = 12;
  const TAP_MS = 320;
  const SCROLL_DIV = 1.25;
  const SWIPE_DIST = 55;
  const SWIPE_RATIO = 1.5;
  const SHAKE_DELTA = 20;
  const ORI_SHAKE_DELTA = 62;
  const SHAKE_WINDOW = 800;
  const SHAKE_COOLDOWN = 1500;

  // pulisce eventuali query di cache-busting (?r=...) dall'URL, così la barra
  // resta pulita e l'icona salvata su Home non memorizza il parametro.
  if (location.search) {
    try { history.replaceState(null, "", location.pathname); } catch (_) {}
  }

  const $ = (id) => document.getElementById(id);
  const pad = $("trackpad");
  const canvas = $("dotcanvas");
  const range = $("sensitivity");
  const value = $("sensitivityValue");
  const toastEl = $("toast");
  const diagEl = $("diag");
  const cal = $("calibrate");
  const powerBtn = $("power");
  const conn = $("connection");
  const device = $("device");
  const statusText = $("statusText");
  const dashBtn = $("dash");
  const cinema = $("cinema");
  const cineBack = $("cineBack");
  const chevron = $("chevron");
  const sheet = $("sheet");
  const sheetHandle = $("sheetHandle");
  const textInput = $("textInput");
  const sendTextBtn = $("sendText");
  const micBtn = $("mic");
  const precisionBtn = $("precision");
  const invXBtn = $("invX");
  const invYBtn = $("invY");
  const ptr = $("ptr");
  const ptrLabel = $("ptrLabel");
  const confirmEl = $("confirm");
  const confirmOk = $("confirmOk");
  const confirmCancel = $("confirmCancel");

  const settings = Object.assign(
    { sens: 50, precision: false, invX: false, invY: false },
    JSON.parse(localStorage.getItem("mouse_phone.v4") || "{}")
  );

  let hostname = "";
  let connected = false;
  let powerOn = true;
  let sensorsOn = false;
  let motionOn = false;
  let calib = null;
  let cur = null;
  let pos = { x: 0.5, y: 0.5 };
  let lastSent = null;
  let anchored = false;
  let gyroPaused = false;
  let calHoldTimer = null;
  let calLongFired = false;
  let sheetOpen = false;
  let cinemaOpen = false;
  let toastTimer = null;
  let es = null;
  let outbox = [];
  let flushing = false;
  let flushTimer = null;
  let lastFlushAt = 0;
  let lastEventAt = performance.now();
  let disconnectedSince = 0;
  let hasEverConnected = false;
  let lastHardReloadAt = 0;
  let lastError = "";
  let closeInfo = "";
  let attempts = 0;
  let edgeX = 0;
  let edgeY = 0;
  let shakePrev = null;
  let oriShakePrev = null;
  let shakeAt = -1e9;
  let joltTimes = [];

  // ---------- filtro One Euro (con supporto angoli) ----------
  class OneEuro {
    constructor(minCutoff = 1.0, beta = 0.02, dCutoff = 1.0, isAngle = false) {
      this.minCutoff = minCutoff;
      this.beta = beta;
      this.dCutoff = dCutoff;
      this.isAngle = isAngle;
      this.x = null;
      this.dx = 0;
      this.t = null;
    }
    reset() {
      this.x = null;
      this.dx = 0;
      this.t = null;
    }
    _alpha(cutoff, dt) {
      const tau = 1 / (2 * Math.PI * cutoff);
      return 1 / (1 + tau / dt);
    }
    _diff(a, b) {
      return this.isAngle ? angDiff(a, b) : a - b;
    }
    filter(x, t) {
      if (this.x === null) {
        this.x = x;
        this.t = t;
        return x;
      }
      const dt = Math.max(1e-3, (t - this.t) / 1000);
      this.t = t;
      const dxRaw = this._diff(x, this.x) / dt;
      const ad = this._alpha(this.dCutoff, dt);
      this.dx += ad * (dxRaw - this.dx);
      const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
      const a = this._alpha(cutoff, dt);
      this.x += a * this._diff(x, this.x);
      if (this.isAngle) this.x = (this.x + 360) % 360;
      return this.x;
    }
  }
  const euroH = new OneEuro(1.0, 0.02, 1.0, true);
  const euroE = new OneEuro(1.0, 0.02, 1.0, false);

  // ---------- utilità ----------
  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  function angDiff(a, a0) {
    return ((a - a0 + 540) % 360) - 180;
  }

  // Punta del phone (+y) nel frame terrestre, convenzione W3C Z-X'-Y''
  function ray(alpha, beta) {
    const a = alpha * DEG;
    const b = beta * DEG;
    const cB = Math.cos(b);
    const vx = -Math.sin(a) * cB;
    const vy = Math.cos(a) * cB;
    const vz = Math.sin(b);
    const h = (Math.atan2(vx, vy) / DEG + 360) % 360;
    const e = Math.asin(Math.max(-1, Math.min(1, vz))) / DEG;
    return { h, e };
  }

  function sensMult() {
    return Math.pow(2, (settings.sens - 50) / 25) * (settings.precision ? 0.25 : 1);
  }

  function save() {
    localStorage.setItem("mouse_phone.v4", JSON.stringify(settings));
  }

  function toastMsg(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1700);
  }

  function send(obj) {
    if (powerOn) enqueue(obj);
  }

  // segnala i cambi di stato (usato da cinema.js per il tema offline)
  function updateStatusDot() {
    document.dispatchEvent(new CustomEvent("dot:status"));
  }

  function updateMode() {
    updateStatusDot();
  }

  function updateConn() {
    const up = connected && powerOn;
    conn.classList.toggle("off", !up);
    statusText.textContent = up ? "● CONNECTED" : "○ DISCONNECTED";
    if (hostname) device.textContent = `MOUSE_PHONE / ${hostname.toUpperCase()} · ${BUILD}`;
    updateDiag(up);
    updateStatusDot();
  }

  function updateDiag(up) {
    if (!diagEl) return;
    const standalone = !!window.navigator.standalone;
    if (up || (!standalone && attempts < 1)) {
      diagEl.classList.remove("show");
      return;
    }
    const mode = standalone ? "WEBAPP" : "SAFARI";
    const state = es ? (connected ? "OPEN" : "RECONNECT") : "none";
    const hint = standalone ? " · rimuovi l'icona e ri-aggiungila SENZA 'Apri come app web'" : "";
    diagEl.textContent =
      `${BUILD} ${mode} · ${location.origin} · sse:${state} · err:${lastError || "-"} · close:${closeInfo || "-"} · tent#${attempts}${hint}`;
    diagEl.classList.add("show");
  }

  // ---------- trasporto realtime: EventSource (ricezione) + fetch (invio) ----------
  // Niente WebSocket: in WKWebView la WSS valida il certificato con un percorso
  // separato che rifiuta la CA locale, mentre fetch/EventSource usano lo stesso
  // percorso dei file dell'app (funziona anche nella web app a tutto schermo).
  function hardReload() {
    try {
      location.reload();
    } catch (_) {
      const u = new URL(location.href);
      u.searchParams.set("r", Date.now());
      location.replace(u.toString());
    }
  }

  function handleServerMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "status") {
      if (msg.hostname) hostname = msg.hostname;
      if (msg.trusted === false) toastMsg("MANCA PERMESSO ACCESSIBILITÀ SUL MAC");
      updateConn();
    }
    // inoltra a cinema.js (bookmarks/settings/displays/queue/history/nowplaying...)
    document.dispatchEvent(new CustomEvent("dot:server", { detail: msg }));
  }

  function connect() {
    if (es) return;
    const src = new EventSource("api/events");
    es = src;
    src.onopen = () => {
      if (es !== src) return;
      connected = true;
      hasEverConnected = true;
      lastEventAt = performance.now();
      disconnectedSince = 0;
      lastError = "";
      closeInfo = "";
      attempts = 0;
      updateConn();
    };
    src.onmessage = (ev) => {
      if (es !== src) return;
      lastEventAt = performance.now();
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      handleServerMessage(msg);
    };
    src.onerror = () => {
      if (es !== src) return;
      if (connected) attempts++;
      connected = false;
      closeInfo = "flusso SSE interrotto";
      if (!disconnectedSince) disconnectedSince = performance.now();
      updateConn();
      // EventSource ritenta da solo; il watchdog interviene se resta fermo.
    };
  }

  function reconnect() {
    if (es) {
      try { es.close(); } catch (_) {}
      es = null;
    }
    connect();
  }

  function enqueue(obj) {
    if (obj.type === "move") {
      const last = outbox[outbox.length - 1];
      if (last && last.type === "move") outbox[outbox.length - 1] = obj;
      else outbox.push(obj);
    } else {
      outbox.push(obj);
    }
    scheduleFlush(0);
  }

  function scheduleFlush(delay) {
    if (flushTimer || flushing || !outbox.length) return;
    const wait = Math.max(delay || 0, 12 - (performance.now() - lastFlushAt));
    flushTimer = setTimeout(flush, wait);
  }

  async function flush() {
    flushTimer = null;
    if (flushing || !outbox.length) return;
    flushing = true;
    lastFlushAt = performance.now();
    const batch = outbox;
    outbox = [];
    try {
      const res = await fetch("api/input", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(batch),
        cache: "no-store",
        keepalive: true,
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      lastEventAt = performance.now();
      if (!connected) {
        connected = true;
        hasEverConnected = true;
        disconnectedSince = 0;
        lastError = "";
        closeInfo = "";
        updateConn();
      }
    } catch (err) {
      lastError = "invio fallito";
      for (let i = batch.length - 1; i >= 0; i--) {
        if (batch[i].type !== "move") outbox.unshift(batch[i]);
      }
      if (connected) attempts++;
      connected = false;
      if (!disconnectedSince) disconnectedSince = performance.now();
      updateConn();
    } finally {
      flushing = false;
    }
    if (outbox.length) scheduleFlush(0);
  }

  connect();

  // ciclo di vita: EventSource si riconnette da solo; quando torniamo in primo
  // piano rilanciamo la connessione se serve.
  window.addEventListener("pageshow", () => connect());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (!connected) reconnect();
    else if (performance.now() - lastEventAt > 20000) reconnect();
  });

  // watchdog: iOS può sospendere il flusso SSE senza avvisare; qui lo riapriamo
  // e, se davvero non si riprende, ricarichiamo una volta l'app.
  setInterval(() => {
    const now = performance.now();
    updateDiag(connected && powerOn);
    if (!es) {
      connect();
      return;
    }
    if (connected && now - lastEventAt > 30000) {
      reconnect();
      return;
    }
    if (!connected) {
      if (!disconnectedSince) disconnectedSince = now;
      if (hasEverConnected && now - disconnectedSince > 20000 && now - lastHardReloadAt > 20000) {
        lastHardReloadAt = now;
        hardReload();
      }
    }
  }, 3000);


  // ---------- haptics ----------
  const hapticOK = (() => {
    try {
      return "switch" in document.createElement("input");
    } catch (_) {
      return false;
    }
  })();
  let audioCtx = null;
  let progSwitch = null;

  function audioTick() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = "square";
      o.frequency.value = 1600;
      g.gain.setValueAtTime(0.06, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.03);
      o.connect(g).connect(audioCtx.destination);
      o.start();
      o.stop(audioCtx.currentTime + 0.04);
    } catch (_) {}
  }

  // switch nascosto su body: consente a hapticTick() di far vibrare a comando
  // (long-press, bordo schermo, media, chip...). Attivo fino a iOS ~26.4: dalla
  // 26.5 Apple ha bloccato il trigger via codice, quindi lì resta silenzioso.
  if (hapticOK) {
    try {
      const label = document.createElement("label");
      label.setAttribute("aria-hidden", "true");
      Object.assign(label.style, {
        position: "fixed", left: "-9999px", top: "0",
        width: "1px", height: "1px", overflow: "hidden", pointerEvents: "none",
      });
      const sw = document.createElement("input");
      sw.type = "checkbox";
      sw.setAttribute("switch", "");
      sw.tabIndex = -1;
      Object.assign(sw.style, { width: "1px", height: "1px", margin: "0" });
      sw.addEventListener("click", (e) => e.stopPropagation());
      label.append(sw);
      document.body.append(label);
      progSwitch = { label, sw };
    } catch (_) {}
  }

  function hapticTick() {
    if (progSwitch) {
      try { progSwitch.label.click(); } catch (_) {}
      return;
    }
    if (navigator.vibrate) navigator.vibrate(8);
    else audioTick();
  }

  function injectHaptic(el) {
    if (!hapticOK) return;
    const label = document.createElement("label");
    label.setAttribute("aria-hidden", "true");
    const radius = getComputedStyle(el).borderRadius;
    Object.assign(label.style, {
      position: "absolute",
      inset: "0",
      borderRadius: radius === "0px" ? "inherit" : radius,
      touchAction: "manipulation",
      zIndex: "3",
      WebkitTapHighlightColor: "transparent",
      WebkitUserSelect: "none",
      userSelect: "none",
      WebkitTouchCallout: "none",
    });
    const sw = document.createElement("input");
    sw.type = "checkbox";
    sw.setAttribute("switch", "");
    Object.assign(sw.style, {
      position: "absolute",
      width: "1px",
      height: "1px",
      margin: "0",
      visibility: "hidden",
    });
    sw.addEventListener("click", (e) => e.stopPropagation());
    label.append(sw);
    if (getComputedStyle(el).position === "static") el.style.position = "relative";
    el.append(label);
  }

  // ---------- sensori ----------
  // Su iOS i permessi vanno richiesti DENTRO il gesto utente e SENZA await prima:
  // se aspettiamo il primo, il secondo (accelerometro) viene ignorato. Li lanciamo
  // quindi insieme, poi risolviamo.
  function ensureSensors() {
    const tasks = [];
    try {
      if (!sensorsOn && typeof DeviceOrientationEvent !== "undefined") {
        if (typeof DeviceOrientationEvent.requestPermission === "function") {
          tasks.push(
            DeviceOrientationEvent.requestPermission()
              .then((r) => {
                if (r === "granted") {
                  window.addEventListener("deviceorientation", onOrientation);
                  sensorsOn = true;
                }
              })
              .catch(() => {})
          );
        } else {
          window.addEventListener("deviceorientation", onOrientation);
          sensorsOn = true;
        }
      }
      if (!motionOn && typeof DeviceMotionEvent !== "undefined") {
        if (typeof DeviceMotionEvent.requestPermission === "function") {
          tasks.push(
            DeviceMotionEvent.requestPermission()
              .then((r) => {
                if (r === "granted") {
                  window.addEventListener("devicemotion", onMotion);
                  motionOn = true;
                  toastMsg("SHAKE ATTIVO · SCUOTI IL TELEFONO");
                } else {
                  toastMsg("SHAKE: PERMESSO MOVIMENTO NEGATO");
                }
              })
              .catch(() => {})
          );
        } else {
          window.addEventListener("devicemotion", onMotion);
          motionOn = true;
        }
      }
    } catch (_) {}
    return Promise.all(tasks);
  }

  // shake: due scossoni ravvicinati -> alert di conferma
  function shakeJolt(now) {
    joltTimes.push(now);
    joltTimes = joltTimes.filter((t) => now - t < SHAKE_WINDOW);
    if (joltTimes.length >= 2 && now - shakeAt > SHAKE_COOLDOWN) {
      shakeAt = now;
      joltTimes = [];
      openConfirm();
    }
  }

  function onMotion(e) {
    if (!powerOn || !confirmEl.hidden || gyroPaused) {
      shakePrev = null;
      return;
    }
    const a = e.accelerationIncludingGravity || e.acceleration;
    if (!a || a.x == null) return;
    if (!shakePrev) { shakePrev = { x: a.x, y: a.y, z: a.z }; return; }
    const delta =
      Math.abs(a.x - shakePrev.x) + Math.abs(a.y - shakePrev.y) + Math.abs(a.z - shakePrev.z);
    shakePrev = { x: a.x, y: a.y, z: a.z };
    if (delta > SHAKE_DELTA) shakeJolt(performance.now());
  }

  function openConfirm() {
    if (!confirmEl.hidden) return;
    confirmEl.hidden = false;
    requestAnimationFrame(() => confirmEl.classList.add("show"));
    hapticTick();
  }

  function closeConfirm() {
    confirmEl.classList.remove("show");
    setTimeout(() => { confirmEl.hidden = true; }, 180);
  }

  function edgeCheck() {
    const ex = pos.x <= 0 || pos.x >= 1 ? 1 : 0;
    const ey = pos.y <= 0 || pos.y >= 1 ? 1 : 0;
    if ((ex && !edgeX) || (ey && !edgeY)) {
      pad.classList.remove("edgeflash");
      void pad.offsetWidth;
      pad.classList.add("edgeflash");
      hapticTick();
    }
    edgeX = ex;
    edgeY = ey;
  }

  function flushMove() {
    if (!lastSent || Math.abs(pos.x - lastSent.x) > DEADZONE || Math.abs(pos.y - lastSent.y) > DEADZONE) {
      lastSent = { x: pos.x, y: pos.y };
      send({ type: "move", x: pos.x, y: pos.y });
    }
  }

  function onOrientation(e) {
    if (e.alpha == null || e.beta == null) return;

    // shake (fallback): se l'accelerometro non è disponibile usiamo l'orientamento,
    // che è sempre attivo perché serve al puntatore.
    if (typeof e.beta === "number" && typeof e.gamma === "number") {
      if (powerOn && confirmEl.hidden && oriShakePrev && !gyroPaused) {
        const d = Math.abs(e.beta - oriShakePrev.b) + Math.abs(e.gamma - oriShakePrev.g);
        if (d > ORI_SHAKE_DELTA && d < 180) shakeJolt(performance.now());
      }
      oriShakePrev = { b: e.beta, g: e.gamma };
    }

    const r = ray(e.alpha, e.beta);
    const t = e.timeStamp || performance.now();
    const h = euroH.filter(r.h, t);
    const el = euroE.filter(r.e, t);
    cur = { h, e: el };

    if (!sensorsOn || !calib || !powerOn || anchored || gyroPaused) {
      if (anchored && calib) {
        const mult = sensMult();
        const sx = settings.invX ? -1 : 1;
        const sy = settings.invY ? -1 : 1;
        const dH = (pos.x - 0.5) / (sx * GAIN_X * mult);
        const dE = (0.5 - pos.y) / (sy * GAIN_Y * mult);
        calib = { h0: h - dH, e0: el - dE };
      }
      return;
    }

    const mult = sensMult();
    const sx = settings.invX ? -1 : 1;
    const sy = settings.invY ? -1 : 1;
    const dH = angDiff(h, calib.h0);
    const dE = el - calib.e0;
    const nx = 0.5 + sx * dH * GAIN_X * mult;
    const ny = 0.5 - sy * dE * GAIN_Y * mult;

    pos.x += (clamp01(nx) - pos.x) * EMA;
    pos.y += (clamp01(ny) - pos.y) * EMA;
    edgeCheck();
    flushMove();
  }

  // ---------- fluid dot trail (solo rendering) ----------
  const ctx = canvas.getContext("2d", { alpha: false });
  const GAP = 19;
  const POINT_RADIUS = 1.38;
  const TRAIL_FADE = 850;
  const PULSE_FADE = 460;
  let cw = 0;
  let ch = 0;
  let trail = [];
  let pulse = [];
  let hadActivity = true;

  // colori del canvas sincronizzati col tema (light/dark)
  let BG = "#fbfbfa";
  let DOT_IDLE = "#bcbcbc";
  let DOT_FADE = "174,174,174";
  const darkMQ = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  function refreshThemeColors() {
    const rs = getComputedStyle(document.documentElement);
    BG = rs.getPropertyValue("--paper").trim() || BG;
    DOT_IDLE = rs.getPropertyValue("--dot").trim() || DOT_IDLE;
    DOT_FADE = rs.getPropertyValue("--dot-fade").trim() || DOT_FADE;
    hadActivity = true;
  }
  refreshThemeColors();
  if (darkMQ && darkMQ.addEventListener) darkMQ.addEventListener("change", refreshThemeColors);
  else if (darkMQ && darkMQ.addListener) darkMQ.addListener(refreshThemeColors);

  function resizeCanvas() {
    const rect = pad.getBoundingClientRect();
    cw = rect.width;
    ch = rect.height;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(cw * dpr));
    canvas.height = Math.max(1, Math.round(ch * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    hadActivity = true;
  }
  new ResizeObserver(resizeCanvas).observe(pad);
  resizeCanvas();

  function addTrailPoint(x, y, t) {
    const last = trail[trail.length - 1];
    if (last) {
      const dist = Math.hypot(x - last.x, y - last.y);
      const n = Math.min(40, Math.floor(dist / 5));
      for (let k = 1; k <= n; k++) {
        const f = k / (n + 1);
        trail.push({ x: last.x + (x - last.x) * f, y: last.y + (y - last.y) * f, t: t - 2 * (n + 1 - k) });
      }
    }
    trail.push({ x, y, t });
    if (trail.length > 260) trail.splice(0, trail.length - 260);
  }

  function addPulse(x, y) {
    pulse.push({ x, y, t: performance.now() });
  }

  function draw(time) {
    if (!cw || !ch) {
      requestAnimationFrame(draw);
      return;
    }
    const active = trail.length > 0 || pulse.length > 0;
    if (!active && !hadActivity) {
      requestAnimationFrame(draw);
      return;
    }
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, cw, ch);
    trail = trail.filter((p) => time - p.t < TRAIL_FADE);
    pulse = pulse.filter((p) => time - p.t < PULSE_FADE);

    const cols = Math.ceil(cw / GAP);
    const rows = Math.ceil(ch / GAP);
    const startX = (cw - (cols - 1) * GAP) / 2;
    const startY = (ch - (rows - 1) * GAP) / 2;
    const span = Math.max(1, trail.length - 1);

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const x = startX + col * GAP;
        const y = startY + row * GAP;
        let influence = 0;
        let hue = 0;

        for (let i = trail.length - 1; i >= 0; i -= 2) {
          const p = trail[i];
          const life = 1 - (time - p.t) / TRAIL_FADE;
          if (life <= 0) continue;
          const radius = 4 + 40 * Math.pow(life, 0.8);
          const dx = x - p.x;
          const dy = y - p.y;
          if (Math.abs(dx) > radius * 1.5 || Math.abs(dy) > radius * 1.5) continue;
          const a = Math.exp(-(dx * dx + dy * dy) / (radius * radius * 0.52)) * Math.pow(life, 1.5);
          if (a > influence) {
            influence = a;
            hue = 208 + 92 * (i / span);
          }
        }

        for (const p of pulse) {
          const progress = (time - p.t) / PULSE_FADE;
          const rad = 10 + 78 * progress;
          const dist = Math.hypot(x - p.x, y - p.y);
          const a = Math.exp(-Math.pow((dist - rad) / (15 + 12 * progress), 2)) * (1 - progress) * 0.85;
          if (a > influence) {
            influence = a;
            hue = 280;
          }
        }

        const dotSize = POINT_RADIUS + Math.min(1, Math.pow(influence, 0.9)) * 0.85;
        ctx.beginPath();
        ctx.arc(x, y, dotSize, 0, Math.PI * 2);
        if (influence > 0.025) {
          const lum = 66 + 8 * (1 - influence);
          ctx.fillStyle = `hsl(${hue.toFixed(0)} 83% ${lum}% / ${Math.min(0.96, 0.15 + influence * 0.85)})`;
          ctx.fill();
          if (influence < 0.65) {
            ctx.fillStyle = `rgba(${DOT_FADE},${(1 - influence) * 0.52})`;
            ctx.fill();
          }
        } else {
          ctx.fillStyle = DOT_IDLE;
          ctx.fill();
        }
      }
    }
    hadActivity = active;
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);

  // ---------- trackpad ----------
  const pointers = new Map();
  let press = null;
  let padCentroid = null;
  let twoFinger = null;
  let threeFinger = null;
  let scrollVelX = 0;
  let scrollVelY = 0;
  let scrollLastAt = 0;
  let momentumRaf = null;

  // inerzia dello scroll (momentum) dopo il rilascio delle due dita
  function stopMomentum() {
    if (momentumRaf) cancelAnimationFrame(momentumRaf);
    momentumRaf = null;
    scrollVelX = 0;
    scrollVelY = 0;
  }

  function startMomentum() {
    if (performance.now() - scrollLastAt > 140) return;
    let mvx = scrollVelX * 0.016;
    let mvy = scrollVelY * 0.016;
    if (Math.hypot(mvx, mvy) < 0.6) return;
    const step = () => {
      send({ type: "scroll", dx: mvx, dy: mvy });
      mvx *= 0.94;
      mvy *= 0.94;
      if (Math.abs(mvx) < 0.5 && Math.abs(mvy) < 0.5) {
        momentumRaf = null;
        return;
      }
      momentumRaf = requestAnimationFrame(step);
    };
    momentumRaf = requestAnimationFrame(step);
  }

  function padPos(e) {
    const r = pad.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function paint(e) {
    const p = padPos(e);
    addTrailPoint(p.x, p.y, performance.now());
  }

  function moveBy(dx, dy) {
    const rect = pad.getBoundingClientRect();
    const k = sensMult() / rect.width;
    pos.x = clamp01(pos.x + dx * k);
    pos.y = clamp01(pos.y + dy * k);
    edgeCheck();
    flushMove();
  }

  function clearPress() {
    if (press && press.timer) clearTimeout(press.timer);
    press = null;
  }

  pad.addEventListener("pointerdown", (e) => {
    if (!powerOn) return;
    stopMomentum();
    ensureSensors();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) trail = [];
    paint(e);
    pad.classList.add("active");
    anchored = true;
    updateMode();

    if (pointers.size === 1) {
      press = {
        t0: Date.now(),
        x0: e.clientX,
        y0: e.clientY,
        prior: { x: e.clientX, y: e.clientY },
        moved: false,
        rightFired: false,
        timer: setTimeout(() => {
          if (press && !press.moved) {
            press.rightFired = true;
            send({ type: "click", button: "right" });
            toastMsg("RIGHT CLICK");
            hapticTick();
          }
        }, LONG_PRESS_MS),
      };
    } else {
      clearPress();
      padCentroid = null;
      if (pointers.size === 2) {
        const pts = [...pointers.values()];
        twoFinger = {
          t0: Date.now(),
          moved: false,
          x0: (pts[0].x + pts[1].x) / 2,
          y0: (pts[0].y + pts[1].y) / 2,
        };
      } else if (pointers.size === 3) {
        // tre dita: niente scroll/click, gestiamo lo swipe tra le scrivanie
        twoFinger = null;
        const pts = [...pointers.values()];
        threeFinger = {
          fired: false,
          x0: (pts[0].x + pts[1].x + pts[2].x) / 3,
          y0: (pts[0].y + pts[1].y + pts[2].y) / 3,
        };
      }
    }
  });

  window.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!powerOn) return;
    paint(e);

    if (pointers.size === 1 && press) {
      const dx = e.clientX - press.prior.x;
      const dy = e.clientY - press.prior.y;
      press.prior = { x: e.clientX, y: e.clientY };
      if (Math.hypot(e.clientX - press.x0, e.clientY - press.y0) > TAP_DIST) {
        press.moved = true;
        if (press.timer) clearTimeout(press.timer);
      }
      moveBy(dx, dy);
    } else if (pointers.size >= 3 && threeFinger) {
      // swipe orizzontale con 3 dita -> cambia scrivania sul Mac
      const pts = [...pointers.values()];
      let sx = 0;
      let sy = 0;
      for (const p of pts) {
        sx += p.x;
        sy += p.y;
      }
      const cx = sx / pts.length;
      const cy = sy / pts.length;
      if (!threeFinger.fired) {
        const dx = cx - threeFinger.x0;
        const dy = cy - threeFinger.y0;
        if (Math.abs(dx) > SWIPE_DIST && Math.abs(dx) > Math.abs(dy) * SWIPE_RATIO) {
          threeFinger.fired = true;
          // dita a destra -> scrivania a sinistra (come il trackpad del Mac)
          const dir = dx > 0 ? "left" : "right";
          send({ type: "space", dir });
          hapticTick();
          toastMsg(dir === "right" ? "SCRIVANIA ▶" : "◀ SCRIVANIA");
        }
      }
    } else if (pointers.size >= 2) {
      const pts = [...pointers.values()];
      const cx = (pts[0].x + pts[1].x) / 2;
      const cy = (pts[0].y + pts[1].y) / 2;
      if (twoFinger && Math.hypot(cx - twoFinger.x0, cy - twoFinger.y0) > TAP_DIST) {
        twoFinger.moved = true;
      }
      const canScroll = !twoFinger || twoFinger.moved;
      if (padCentroid && canScroll) {
        const k = sensMult() / SCROLL_DIV;
        const now = performance.now();
        const dt = Math.max(1, now - (scrollLastAt || now - 16));
        // direzione invertita rispetto al trascinamento (scorrimento "naturale")
        const dxs = -(cx - padCentroid.x) * k;
        const dys = -(cy - padCentroid.y) * k;
        // stima velocità (px/s) per l'inerzia, con smoothing
        scrollVelX = scrollVelX * 0.6 + (dxs / dt) * 1000 * 0.4;
        scrollVelY = scrollVelY * 0.6 + (dys / dt) * 1000 * 0.4;
        scrollLastAt = now;
        send({ type: "scroll", dx: dxs, dy: dys });
      }
      padCentroid = { x: cx, y: cy };
    }
  });

  function releasePointer(e) {
    if (!pointers.has(e.pointerId)) return;
    const before = pointers.size;
    pointers.delete(e.pointerId);

    // tap con due dita (senza trascinare) -> clic destro
    if (twoFinger && before === 2 && !twoFinger.moved && Date.now() - twoFinger.t0 < TAP_MS) {
      const pts = [...pointers.values()];
      if (pts.length) {
        const p = padPos({ clientX: pts[0].x, clientY: pts[0].y });
        addPulse(p.x, p.y);
      }
      send({ type: "click", button: "right" });
      hapticTick();
      toastMsg("RIGHT CLICK");
    }
    // fine dello scroll a due dita -> avvia l'inerzia
    if (twoFinger && before === 2 && twoFinger.moved) startMomentum();
    if (pointers.size < 2) twoFinger = null;
    if (pointers.size < 3) threeFinger = null;

    if (pointers.size === 0) {
      if (press) {
        const isTap = !press.rightFired && !press.moved && Date.now() - press.t0 < TAP_MS;
        if (press.timer) clearTimeout(press.timer);
        if (isTap) {
          const p = padPos(e);
          addPulse(p.x, p.y);
          send({ type: "click", button: "left" });
          hapticTick();
        }
        press = null;
      }
      anchored = false;
      padCentroid = null;
      updateMode();
      setTimeout(() => {
        if (pointers.size === 0) pad.classList.remove("active");
      }, 160);
    } else {
      clearPress();
      padCentroid = null;
    }
  }

  window.addEventListener("pointerup", releasePointer);
  window.addEventListener("pointercancel", releasePointer);

  // ---------- power ----------
  powerBtn.addEventListener("click", () => {
    ensureSensors();
    powerOn = !powerOn;
    powerBtn.classList.toggle("off", !powerOn);
    if (!powerOn) {
      clearPress();
      pointers.clear();
      stopMomentum();
      twoFinger = null;
      threeFinger = null;
      anchored = false;
      pad.classList.remove("active");
      trail = [];
      pulse = [];
      toastMsg("DEVICE DISCONNECTED");
    } else {
      toastMsg("DEVICE CONNECTED");
    }
    updateConn();
    updateMode();
  });

  // ---------- calibrazione ----------
  async function doRecenter() {
    await ensureSensors();
    cal.classList.remove("spin");
    void cal.offsetWidth;
    cal.classList.add("spin");
    if (!cur) {
      toastMsg("SENSORI NON PRONTI · USA IL TRACKPAD");
      return false;
    }
    euroH.reset();
    euroE.reset();
    calib = { h0: cur.h, e0: cur.e };
    pos = { x: 0.5, y: 0.5 };
    lastSent = { x: 0.5, y: 0.5 };
    send({ type: "move", x: 0.5, y: 0.5 });
    return true;
  }

  function setGyroPaused(v) {
    gyroPaused = v;
    cal.classList.toggle("paused", v);
    updateMode();
    hapticTick();
    if (v) {
      toastMsg("GIROSCOPIO IN PAUSA · TOCCA PER RIPRENDERE");
    } else {
      doRecenter();
      toastMsg("GIROSCOPIO ATTIVO");
    }
  }

  function endCalHold() {
    if (calHoldTimer) {
      clearTimeout(calHoldTimer);
      calHoldTimer = null;
    }
  }

  cal.addEventListener("pointerdown", () => {
    calLongFired = false;
    endCalHold();
    calHoldTimer = setTimeout(() => {
      calHoldTimer = null;
      calLongFired = true;
      setGyroPaused(!gyroPaused);
    }, CAL_HOLD_MS);
  });
  cal.addEventListener("pointerup", endCalHold);
  cal.addEventListener("pointercancel", endCalHold);
  cal.addEventListener("pointerleave", endCalHold);

  cal.addEventListener("click", async () => {
    if (calLongFired) {
      calLongFired = false;
      return;
    }
    if (gyroPaused) {
      setGyroPaused(false);
      return;
    }
    if (await doRecenter()) toastMsg("CALIBRATION COMPLETE");
    updateMode();
    hapticTick();
  });

  // ---------- sheet ----------
  function toggleSheet(open) {
    sheetOpen = typeof open === "boolean" ? open : !sheetOpen;
    sheet.classList.toggle("open", sheetOpen);
  }

  chevron.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleSheet();
    hapticTick();
  });
  sheetHandle.addEventListener("click", () => toggleSheet(false));
  document.addEventListener("pointerdown", (e) => {
    if (!sheetOpen) return;
    if (e.target.closest(".sheet")) return;
    if (e.target.closest("#chevron")) return;
    toggleSheet(false);
  });
  conn.addEventListener("click", () => {
    if (!connected || !powerOn) {
      toastMsg("RICONNESSIONE…");
      hardReload();
      return;
    }
    toastMsg(`CONNECTED TO ${hostname || "MAC"}`);
  });

  // ---------- cinema ----------
  function setCinema(open) {
    cinemaOpen = open;
    cinema.classList.toggle("open", open);
    cinema.setAttribute("aria-hidden", open ? "false" : "true");
    hapticTick();
    document.dispatchEvent(new CustomEvent("dot:cinema", { detail: { open } }));
  }

  dashBtn.addEventListener("click", () => setCinema(true));
  cineBack.addEventListener("click", () => setCinema(false));

  // ---------- tastiera ----------
  function sendText() {
    const v = textInput.value.trim();
    if (!v) return;
    send({ type: "text", text: v });
    textInput.value = "";
    toastMsg("TESTO INVIATO");
    hapticTick();
  }

  sendTextBtn.addEventListener("click", sendText);
  textInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      sendText();
    }
  });

  // ---------- media ----------
  document.querySelectorAll("[data-media]").forEach((btn) => {
    btn.addEventListener("click", () => {
      send({ type: "media", key: btn.dataset.media });
      hapticTick();
    });
  });

  // ---------- conferma (shake -> chiudi tab) ----------
  confirmCancel.addEventListener("click", closeConfirm);
  confirmOk.addEventListener("click", () => {
    closeConfirm();
    send({ type: "key", key: "w", command: true });
    toastMsg("TAB CHIUSA");
    hapticTick();
  });
  confirmEl.addEventListener("click", (e) => {
    if (e.target === confirmEl) closeConfirm();
  });

  // ogni tocco è un'occasione per ottenere i permessi sensori (iOS: serve un gesto)
  document.addEventListener("pointerdown", ensureSensors);

  // ---------- dettatura ----------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let recording = false;

  micBtn.addEventListener("click", () => {
    if (!SR) {
      toastMsg("DETTATURA NON SUPPORTATA · USA IL TASTIERINO IOS");
      return;
    }
    if (recording) {
      recognition && recognition.stop();
      return;
    }
    recognition = new SR();
    recognition.lang = "it-IT";
    recognition.interimResults = true;
    recognition.continuous = false;

    recognition.onresult = (ev) => {
      let text = "";
      for (let i = 0; i < ev.results.length; i++) text += ev.results[i][0].transcript;
      textInput.value = text;
    };
    recognition.onerror = (ev) => {
      recording = false;
      micBtn.classList.remove("rec");
      toastMsg("ERRORE DETTATURA: " + (ev.error || "").toUpperCase());
    };
    recognition.onend = () => {
      recording = false;
      micBtn.classList.remove("rec");
      if (textInput.value.trim()) toastMsg("TESTO PRONTO · PREMI ↵");
    };
    try {
      recognition.start();
      recording = true;
      micBtn.classList.add("rec");
      toastMsg("PARLA…");
    } catch (_) {}
  });

  // ---------- impostazioni ----------
  function paintSlider() {
    value.textContent = `${settings.sens}%`;
    range.value = settings.sens;
    range.style.background = `linear-gradient(to right,var(--accent) 0%,var(--accent) ${settings.sens}%,var(--line) ${settings.sens}%,var(--line) 100%)`;
  }

  range.addEventListener("input", () => {
    settings.sens = Number(range.value);
    paintSlider();
    save();
  });

  function paintChips() {
    precisionBtn.classList.toggle("active", settings.precision);
    invXBtn.classList.toggle("active", settings.invX);
    invYBtn.classList.toggle("active", settings.invY);
  }

  precisionBtn.addEventListener("click", () => {
    settings.precision = !settings.precision;
    paintChips();
    save();
    hapticTick();
  });
  invXBtn.addEventListener("click", () => {
    settings.invX = !settings.invX;
    paintChips();
    save();
  });
  invYBtn.addEventListener("click", () => {
    settings.invY = !settings.invY;
    paintChips();
    save();
  });

  // ---------- pull to refresh ----------
  const PTR_THRESHOLD = 78;
  const PTR_MAX = PTR_THRESHOLD * 1.7;
  let ptrStartY = null;
  let ptrDy = 0;
  let ptrActive = false;
  let suppressClickUntil = 0;

  function ptrReset() {
    ptr.classList.remove("ready");
    ptr.style.transition = "transform .25s ease, opacity .25s ease";
    ptr.style.transform = "translateY(-70px)";
    ptr.style.opacity = "0";
  }

  function ptrBlocked(target) {
    if (!target || !target.closest) return true;
    if (target.closest(".trackpad")) return true;
    if (target.closest(".sheet")) return true;
    if (target.closest(".cinema")) return true;
    if (target.closest("input")) return true;
    return sheetOpen;
  }

  document.addEventListener(
    "touchstart",
    (e) => {
      if (suppressClickUntil > performance.now()) return;
      if (e.touches.length !== 1 || ptrBlocked(e.target)) {
        ptrStartY = null;
        return;
      }
      ptrStartY = e.touches[0].clientY;
      ptrDy = 0;
      ptrActive = false;
    },
    { passive: true }
  );

  document.addEventListener(
    "touchmove",
    (e) => {
      if (ptrStartY === null) return;
      if (e.touches.length !== 1) {
        ptrStartY = null;
        ptrReset();
        ptrActive = false;
        return;
      }
      const dy = e.touches[0].clientY - ptrStartY;
      if (dy <= 6) return;
      e.preventDefault();
      ptrActive = true;
      ptrDy = Math.min(dy, PTR_MAX);
      const eased = Math.min(ptrDy * 0.55, PTR_THRESHOLD);
      const ready = ptrDy >= PTR_THRESHOLD;
      ptr.style.transition = "none";
      ptr.style.opacity = String(Math.min(1, ptrDy / PTR_THRESHOLD));
      ptr.style.transform = `translateY(${eased}px)`;
      ptr.classList.toggle("ready", ready);
      ptrLabel.textContent = ready ? "RILASCIA PER AGGIORNARE" : "TRASCINA PER AGGIORNARE";
    },
    { passive: false }
  );

  function ptrEnd() {
    if (ptrStartY === null) return;
    const pulled = ptrActive && ptrDy >= PTR_THRESHOLD;
    ptrStartY = null;
    if (pulled) {
      ptr.classList.add("loading");
      ptr.classList.remove("ready");
      ptr.style.transition = "none";
      ptr.style.opacity = "1";
      ptr.style.transform = "translateY(30px)";
      ptrLabel.textContent = "RICARICO…";
      suppressClickUntil = performance.now() + 900;
      setTimeout(hardReload, 220);
      return;
    }
    if (ptrActive) {
      suppressClickUntil = performance.now() + 450;
      ptrReset();
    }
    ptrActive = false;
  }

  document.addEventListener("touchend", ptrEnd);
  document.addEventListener("touchcancel", ptrEnd);

  document.addEventListener(
    "click",
    (e) => {
      if (suppressClickUntil > performance.now()) {
        e.stopPropagation();
        e.preventDefault();
        suppressClickUntil = 0;
      }
    },
    true
  );

  // ---------- init ----------
  injectHaptic(pad);
  injectHaptic(cal);
  paintSlider();
  paintChips();
  updateMode();
  updateConn();

  // API condivisa verso cinema.js (stesso stile/token/toast/haptics)
  window.dot = {
    toast: toastMsg,
    haptic: hapticTick,
    online: () => connected && powerOn,
    status: () => ({ connected, powerOn, gyroPaused, anchored }),
    token: () => window.__DOT_TOKEN__ || "",
    BUILD,
  };
  document.dispatchEvent(new Event("dot:ready"));

  document.addEventListener("gesturestart", (e) => e.preventDefault());
  document.addEventListener("dblclick", (e) => e.preventDefault());
  document.addEventListener("contextmenu", (e) => e.preventDefault());
  document.addEventListener("selectstart", (e) => {
    if (e.target.closest("input, textarea")) return;
    e.preventDefault();
  });
  document.addEventListener(
    "touchmove",
    (e) => {
      if (e.target.closest("input")) return;
      if (e.target.closest(".sheet")) return;
      if (e.target.closest(".cinema")) return;
      if (pad.classList.contains("active")) return;
      e.preventDefault();
    },
    { passive: false }
  );
})();
