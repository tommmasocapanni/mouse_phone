(() => {
  "use strict";

  const DEG = Math.PI / 180;
  const GAIN_X = 1 / (2 * 50);
  const GAIN_Y = 1 / (2 * 40);
  const EMA = 0.32;
  const DEADZONE = 0.002;
  const LONG_PRESS_MS = 350;
  const TAP_DIST = 12;
  const TAP_MS = 320;
  const SCROLL_DIV = 2.5;

  const $ = (id) => document.getElementById(id);
  const pad = $("trackpad");
  const glow = $("glow");
  const cross = $("cross");
  const range = $("sensitivity");
  const value = $("sensitivityValue");
  const toastEl = $("toast");
  const cal = $("calibrate");
  const powerBtn = $("power");
  const conn = $("connection");
  const device = $("device");
  const statusText = $("statusText");
  const mode = $("mode");
  const chevron = $("chevron");
  const sheet = $("sheet");
  const sheetHandle = $("sheetHandle");
  const textInput = $("textInput");
  const sendTextBtn = $("sendText");
  const micBtn = $("mic");
  const precisionBtn = $("precision");
  const invXBtn = $("invX");
  const invYBtn = $("invY");
  const clock = $("clock");

  const settings = Object.assign(
    { sens: 50, precision: false, invX: false, invY: false },
    JSON.parse(localStorage.getItem("mouse_phone.v4") || "{}")
  );

  let ws = null;
  let hostname = "";
  let connected = false;
  let powerOn = true;
  let sensorsOn = false;
  let calib = null;
  let cur = null;
  let pos = { x: 0.5, y: 0.5 };
  let lastSent = null;
  let anchored = false;
  let sheetOpen = false;
  let toastTimer = null;
  let edgeX = 0;
  let edgeY = 0;

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
    if (ws && ws.readyState === WebSocket.OPEN && powerOn) ws.send(JSON.stringify(obj));
  }

  function updateMode() {
    mode.textContent = !powerOn ? "/ OFFLINE" : anchored ? "/ TRACKPAD MODE" : "/ POINTER MODE";
  }

  function updateConn() {
    const up = connected && powerOn;
    conn.classList.toggle("off", !up);
    statusText.textContent = up ? "● CONNECTED" : "○ DISCONNECTED";
    if (hostname) device.textContent = `MOUSE_PHONE / ${hostname.toUpperCase()}`;
  }

  // ---------- WebSocket ----------
  function connect() {
    ws = new WebSocket(`wss://${location.host}`);
    ws.onopen = () => {
      connected = true;
      updateConn();
    };
    ws.onclose = () => {
      connected = false;
      updateConn();
      setTimeout(connect, 900);
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "status") {
          if (msg.hostname) hostname = msg.hostname;
          if (msg.trusted === false) toastMsg("MANCA PERMESSO ACCESSIBILITÀ SUL MAC");
          updateConn();
        }
      } catch (_) {}
    };
  }
  connect();

  // ---------- haptics ----------
  const hapticOK = (() => {
    try {
      return "switch" in document.createElement("input");
    } catch (_) {
      return false;
    }
  })();
  let audioCtx = null;

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

  function hapticTick() {
    if (hapticOK) return;
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
  async function ensureSensors() {
    if (sensorsOn) return;
    try {
      if (typeof DeviceOrientationEvent === "undefined") return;
      if (typeof DeviceOrientationEvent.requestPermission === "function") {
        const res = await DeviceOrientationEvent.requestPermission();
        if (res !== "granted") return;
      }
      window.addEventListener("deviceorientation", onOrientation);
      sensorsOn = true;
    } catch (_) {}
  }

  function edgeCheck() {
    const ex = pos.x <= 0 || pos.x >= 1 ? 1 : 0;
    const ey = pos.y <= 0 || pos.y >= 1 ? 1 : 0;
    if ((ex && !edgeX) || (ey && !edgeY)) {
      pad.classList.remove("edgeflash");
      void pad.offsetWidth;
      pad.classList.add("edgeflash");
      audioTick();
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
    const r = ray(e.alpha, e.beta);
    const t = e.timeStamp || performance.now();
    const h = euroH.filter(r.h, t);
    const el = euroE.filter(r.e, t);
    cur = { h, e: el };

    if (!sensorsOn || !calib || !powerOn || anchored) {
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

  // ---------- trackpad ----------
  const pointers = new Map();
  let press = null;
  let padCentroid = null;

  function padPos(e) {
    const r = pad.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function paint(e) {
    const p = padPos(e);
    glow.style.left = p.x + "px";
    glow.style.top = p.y + "px";
    cross.style.left = p.x + "px";
    cross.style.top = p.y + "px";
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
    ensureSensors();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
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
    } else if (pointers.size >= 2) {
      const pts = [...pointers.values()];
      const cx = (pts[0].x + pts[1].x) / 2;
      const cy = (pts[0].y + pts[1].y) / 2;
      if (padCentroid) {
        const k = sensMult() / SCROLL_DIV;
        send({ type: "scroll", dx: (cx - padCentroid.x) * k, dy: (cy - padCentroid.y) * k });
      }
      padCentroid = { x: cx, y: cy };
    }
  });

  function releasePointer(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);

    if (pointers.size === 0) {
      if (press) {
        const isTap = !press.rightFired && !press.moved && Date.now() - press.t0 < TAP_MS;
        if (press.timer) clearTimeout(press.timer);
        if (isTap) {
          send({ type: "click", button: "left" });
          glow.style.width = "310px";
          glow.style.height = "310px";
          setTimeout(() => {
            glow.style.width = "230px";
            glow.style.height = "230px";
          }, 170);
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
    powerOn = !powerOn;
    powerBtn.classList.toggle("off", !powerOn);
    if (!powerOn) {
      clearPress();
      pointers.clear();
      anchored = false;
      pad.classList.remove("active");
      toastMsg("DEVICE DISCONNECTED");
    } else {
      toastMsg("DEVICE CONNECTED");
    }
    updateConn();
    updateMode();
  });

  // ---------- calibrazione ----------
  cal.addEventListener("click", async () => {
    await ensureSensors();
    cal.classList.remove("spin");
    void cal.offsetWidth;
    cal.classList.add("spin");
    if (!cur) {
      toastMsg("SENSORI NON PRONTI · USA IL TRACKPAD");
      return;
    }
    euroH.reset();
    euroE.reset();
    calib = { h0: cur.h, e0: cur.e };
    pos = { x: 0.5, y: 0.5 };
    lastSent = { x: 0.5, y: 0.5 };
    send({ type: "move", x: 0.5, y: 0.5 });
    toastMsg("CALIBRATION COMPLETE");
    hapticTick();
    updateMode();
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
  conn.addEventListener("click", () => {
    toastMsg(connected && powerOn ? `CONNECTED TO ${hostname || "MAC"}` : "NO DEVICE CONNECTED");
  });

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
    range.style.background = `linear-gradient(to right,#222 0%,#222 ${settings.sens}%,#dedede ${settings.sens}%,#dedede 100%)`;
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

  // ---------- orologio ----------
  function tick() {
    clock.textContent = new Date().toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
  }

  // ---------- init ----------
  injectHaptic(pad);
  injectHaptic(cal);
  paintSlider();
  paintChips();
  updateMode();
  updateConn();
  tick();
  setInterval(tick, 15000);

  document.addEventListener("gesturestart", (e) => e.preventDefault());
  document.addEventListener("dblclick", (e) => e.preventDefault());
  document.addEventListener(
    "touchmove",
    (e) => {
      if (e.target.closest("input")) return;
      if (e.target.closest(".sheet")) return;
      if (pad.classList.contains("active")) return;
      e.preventDefault();
    },
    { passive: false }
  );
})();
