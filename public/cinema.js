/* View "Cinema" — launcher, bookmark, display di destinazione, cartella film.
   Riusa lo stile dot.: token dal server, toast/haptics da window.dot (app.js). */
(() => {
  "use strict";
  const dot = window.dot;
  if (!dot) return;

  const bodyEl = document.getElementById("cineBody");
  const sheetEl = document.getElementById("cineSheet");
  const cardEl = document.getElementById("cineSheetCard");
  const settingsBtn = document.getElementById("cineSettings");
  const castBtn = document.getElementById("cineCast");
  const castModalEl = document.getElementById("castModal");
  const castModalCard = document.getElementById("castModalCard");

  const token = dot.token();
  const state = {
    bookmarks: [],
    settings: null,
    displays: [],
    audio: [],
    target: null,
    loaded: false,
  };

  // ---------- rete (Bearer token iniettato dal server) ----------
  function api(pathname, opts = {}) {
    return fetch(pathname, {
      method: opts.method || "GET",
      headers: Object.assign(
        { Authorization: "Bearer " + token },
        opts.body ? { "Content-Type": "application/json" } : {}
      ),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      cache: "no-store",
    }).then(async (r) => {
      let data = {};
      try { data = await r.json(); } catch (_) {}
      if (!r.ok) throw new Error(data.error || "HTTP " + r.status);
      return data;
    });
  }

  // ---------- helper DOM ----------
  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    attrs = attrs || {};
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k === "html") n.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return n;
  }

  const svg = (inner, sw = 1.6) =>
    h("span", { class: "glyph", html:
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>` });

  function iconNode(icon) {
    if (!icon) return h("span", { class: "tile-glyph", text: "◆" });
    if (/^(data:|https?:\/\/)/i.test(icon)) return h("img", { class: "tile-favicon", src: icon, alt: "" });
    return h("span", { class: "tile-glyph", text: icon });
  }

  // ---------- stato online/offline ----------
  function ensureOnline() {
    if (dot.online()) return true;
    dot.toast("MAC OFFLINE");
    return false;
  }

  function applyOffline() {
    bodyEl.classList.toggle("offline", !dot.online());
  }

  // ---------- sheet (bottom card dentro la view Cinema) ----------
  let sheetIsOpen = false;
  function openSheet(node) {
    cardEl.textContent = "";
    cardEl.append(node);
    sheetEl.classList.add("open");
    sheetEl.setAttribute("aria-hidden", "false");
    sheetIsOpen = true;
  }
  function closeSheet() {
    sheetEl.classList.remove("open");
    sheetEl.setAttribute("aria-hidden", "true");
    sheetIsOpen = false;
  }
  sheetEl.addEventListener("click", (e) => { if (e.target === sheetEl) closeSheet(); });
  castModalEl.addEventListener("click", (e) => { if (e.target === castModalEl) closeCastModal(); });
  castBtn.addEventListener("click", openCastModal);

  function sheetHead(title, onBack) {
    return h("div", { class: "cs-head" },
      onBack ? h("button", { class: "cs-back", text: "‹", onclick: onBack }) : null,
      h("strong", { class: "cs-title", text: title }),
      h("button", { class: "cs-close", text: "✕", onclick: closeSheet })
    );
  }

  // ---------- rendering launcher ----------
  function render() {
    bodyEl.textContent = "";
    bodyEl.append(sectionLauncher());
    applyOffline();
  }

  function sectionLauncher() {
    const grid = h("div", { class: "tile-grid" });
    grid.append(moviesTile());
    for (const bm of state.bookmarks) grid.append(bookmarkTile(bm));
    grid.append(addTile());
    return h("section", { class: "cine-sec" }, barsRow(), grid);
  }

  function barsRow() {
    return h("div", { class: "cine-bars" }, displayBar(), audioBar());
  }

  function audioBar() {
    return h("button", { class: "cine-bar", onclick: () => { dot.haptic(); openAudioSheet(); } },
      h("span", { class: "cine-bar-k", text: "AUDIO" }),
      h("span", { class: "cine-bar-v", text: currentAudioLabel() }),
      h("span", { class: "cine-bar-caret", text: "›" })
    );
  }

  function currentAudioLabel() {
    const d = (state.audio || []).find((x) => x.default);
    return d ? (d.name || "USCITA") : "—";
  }

  function castSvg() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="8" y="2" width="8" height="4" rx="1"/>' +
      '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>';
  }

  function openCastModal() {
    if (!ensureOnline()) return;
    dot.haptic();
    const card = castModalCard;
    card.textContent = "";

    const input = h("input", {
      class: "cs-input cast-input", type: "url", placeholder: "incolla o scrivi un link…",
      autocapitalize: "off", autocorrect: "off", spellcheck: "false", enterkeyhint: "go",
    });
    const pasteBtn = h("button", {
      class: "cast-paste", type: "button", "aria-label": "Incolla dagli appunti", html: castSvg(),
      onclick: async () => {
        try {
          const t = await navigator.clipboard.readText();
          if (t && t.trim()) { input.value = t.trim(); input.focus(); }
          else dot.toast("APPUNTI VUOTI");
        } catch (_) { dot.toast("INCOLLA MANUALMENTE (PERMESSO APPUNTI)"); }
      },
    });

    const send = async (mode) => {
      if (!ensureOnline()) return;
      const url = input.value.trim();
      if (!/^https?:\/\//i.test(url)) { dot.toast("URL NON VALIDO (http/https)"); return; }
      dot.haptic();
      try {
        const r = await api("/api/cast", { method: "POST", body: { url, mode } });
        if (mode === "queue") {
          const n = r && r.added ? r.added : 1;
          dot.toast(n > 1 ? n + " VIDEO AGGIUNTI ALLA CODA" : "AGGIUNTO ALLA CODA");
        } else {
          dot.toast("LANCIATO SUL MAC");
        }
        closeCastModal();
      } catch (e) { dot.toast("ERRORE: " + e.message.toUpperCase()); }
    };

    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); send("open"); } });

    card.append(
      h("div", { class: "cast-row" }, input, pasteBtn),
      h("div", { class: "cast-actions" },
        h("button", { class: "cs-primary cast-launch", type: "button", text: "LANCIA", onclick: () => send("open") }),
        h("button", { class: "cs-primary cast-queue", type: "button", text: "+ CODA", onclick: () => send("queue") })
      )
    );

    castModalEl.classList.add("open");
    castModalEl.setAttribute("aria-hidden", "false");
    setTimeout(() => input.focus(), 80);
  }

  function closeCastModal() {
    castModalEl.classList.remove("open");
    castModalEl.setAttribute("aria-hidden", "true");
  }

  // ---------- now playing (mini-player + schermata a tutto schermo) ----------
  const NP_PLAY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 5l12 7-12 7z"/></svg>';
  const NP_PAUSE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5v14M15 5v14"/></svg>';
  const COVERFLOW_MAX_DISTANCE = 2;
  const COVERFLOW_SCALE = [1, 0.82, 0.68];
  const COVERFLOW_SPACING = [0, 0.66, 0.92];
  const COVERFLOW_ROTATION = [0, 38, 52];
  const COVERFLOW_OPACITY = [1, 0.72, 0.42];
  const COVERFLOW_SHADE = [0, 0.25, 0.5];
  const COVERFLOW_SNAP_PX = 40;
  const np = { running: false, timer: null, busy: false, found: false, paused: true, current: 0, duration: 0, auto: false, next: false, mode: "none", url: "", ending: false, pendingNav: false, scrubbing: false, cinema: false, fullOpen: false, navUntil: 0, queueClearing: false, currentTrack: null };

  // avvia una transizione tra brani: mantiene viva la UI finché il nuovo video
  // non è pronto (evita che il player "sparisca e ricompaia")
  function beginNav() {
    np.pendingNav = true;
    np.navUntil = Date.now() + 8000;
  }
  try { np.auto = localStorage.getItem("dot_autoskip") === "1"; } catch (_) {}
  try { np.next = localStorage.getItem("dot_autoplay") === "1"; } catch (_) {}

  const npMini = document.getElementById("npMini");
  const npMiniArt = document.getElementById("npMiniArt");
  const npMiniTitle = document.getElementById("npMiniTitle");
  const npMiniSub = document.getElementById("npMiniSub");
  const npMiniPlay = document.getElementById("npMiniPlay");
  const homeMini = document.getElementById("homeMini");
  const homeMiniArt = document.getElementById("homeMiniArt");
  const homeMiniTitle = document.getElementById("homeMiniTitle");
  const homeMiniSub = document.getElementById("homeMiniSub");
  const homeMiniPlay = document.getElementById("homeMiniPlay");
  const homeMiniPrev = document.getElementById("homeMiniPrev");
  const homeMiniNext = document.getElementById("homeMiniNext");
  const footnote = document.getElementById("footnote");
  const npFull = document.getElementById("npFull");
  const npFullDown = document.getElementById("npFullDown");
  const npFullAudio = document.getElementById("npFullAudio");
  const npVol = document.getElementById("npVol");
  const npVolTrack = document.getElementById("npVolTrack");
  const npVolFill = document.getElementById("npVolFill");
  const npVolThumb = document.getElementById("npVolThumb");
  const npVolVal = document.getElementById("npVolVal");
  const npBack = document.getElementById("npBack");
  const npFwd = document.getElementById("npFwd");
  const npCoverflow = document.getElementById("npCoverflow");
  const npCoverflowTrack = document.getElementById("npCoverflowTrack");
  const npPreviewPlay = document.getElementById("npPreviewPlay");
  const npFullInfo = document.querySelector(".np-full-info");
  const npFullTitle = document.getElementById("npFullTitle");
  const npFullSite = document.getElementById("npFullSite");
  const npFullTrack = document.getElementById("npFullTrack");
  const npFullFill = document.getElementById("npFullFill");
  const npScrub = document.getElementById("npScrub");
  const npSeekBubble = document.getElementById("npSeekBubble");
  const npFullThumb = document.getElementById("npFullThumb");
  const npFullCur = document.getElementById("npFullCur");
  const npFullDur = document.getElementById("npFullDur");
  const npFullPlay = document.getElementById("npFullPlay");
  const npFullPrev = document.getElementById("npFullPrev");
  const npFullNext = document.getElementById("npFullNext");
  const npFullSkip = document.getElementById("npFullSkip");
  const npFullAuto = document.getElementById("npFullAuto");
  if (npFullSkip) npFullSkip.classList.toggle("active", np.auto);
  if (npFullAuto) npFullAuto.classList.toggle("active", np.next);

  function fmtTime(s) {
    s = Math.max(0, Math.floor(Number(s) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const mm = h ? String(m).padStart(2, "0") : String(m);
    return (h ? h + ":" : "") + mm + ":" + String(ss).padStart(2, "0");
  }

  function setNpIcons(paused) {
    const svgMarkup = paused ? NP_PLAY_SVG : NP_PAUSE_SVG;
    if (npMiniPlay) npMiniPlay.innerHTML = svgMarkup;
    if (npFullPlay) npFullPlay.innerHTML = svgMarkup;
    if (homeMiniPlay) homeMiniPlay.innerHTML = svgMarkup;
  }

  // mini-player nella schermata principale: appare al posto del promemoria 01/INPUT
  function showHomeMini(on) {
    if (homeMini) homeMini.hidden = !on;
    if (footnote) footnote.hidden = on;
  }

  // titolo del mini-player home: scorre se non entra nella larghezza
  let miniTitleText = null;
  function setMiniTitle(text) {
    if (!homeMiniTitle) return;
    const label = text || "MEDIA";
    if (label === miniTitleText) return;
    miniTitleText = label;
    homeMiniTitle.classList.remove("scroll");
    homeMiniTitle.style.removeProperty("--hm-dur");
    homeMiniTitle.textContent = label;
    requestAnimationFrame(() => {
      const need = homeMiniTitle.scrollWidth;
      const have = homeMiniTitle.clientWidth;
      if (need > have + 2) {
        homeMiniTitle.textContent = "";
        const track = h("div", { class: "hm-track" });
        track.append(h("span", { text: label }), h("span", { text: label }));
        homeMiniTitle.append(track);
        homeMiniTitle.style.setProperty("--hm-dur", Math.max(6, need / 22) + "s");
        homeMiniTitle.classList.add("scroll");
      }
    });
  }

  function setArt(el, art, site) {
    let url = art || "";
    if (!url && site) url = "https://www.google.com/s2/favicons?domain=" + encodeURIComponent(site) + "&sz=128";
    if (url) { el.style.backgroundImage = "url(" + JSON.stringify(url) + ")"; el.classList.add("has-art"); }
    else { el.style.backgroundImage = ""; el.classList.remove("has-art"); }
  }

  function openNpFull() {
    if (np.mode !== "media") return;
    dot.haptic();
    np.fullOpen = true;
    npFull.classList.add("show");
    npFull.setAttribute("aria-hidden", "false");
    npCoverflow.classList.remove("ready");
    renderCoverflow();
    requestAnimationFrame(() => npCoverflow.classList.add("ready"));
    if (!queueLoaded) loadQueue();
    pollNp();
  }
  function closeNpFull() {
    np.fullOpen = false;
    npFull.classList.remove("show");
    npFull.setAttribute("aria-hidden", "true");
    closeVol();
    npFull.classList.remove("queue");
    npQueue.hidden = true;
    npFullQueue.classList.remove("active");
    hideNqMenu();
  }

  // ---------- volume di sistema (slider verticale) ----------
  let volValue = null;
  let volDragging = false;
  let volSendTimer = null;

  function renderVol() {
    const v = volValue == null ? 0 : volValue;
    npVolFill.style.height = v + "%";
    npVolThumb.style.bottom = v + "%";
    npVolVal.textContent = volValue == null ? "—" : String(Math.round(v));
  }

  function openVol() {
    npVol.classList.add("show");
    npVol.setAttribute("aria-hidden", "false");
    npFullAudio.classList.add("active");
    loadVolume();
  }
  function closeVol() {
    npVol.classList.remove("show");
    npVol.setAttribute("aria-hidden", "true");
    npFullAudio.classList.remove("active");
  }
  function toggleVol() {
    dot.haptic();
    if (npVol.classList.contains("show")) closeVol();
    else openVol();
  }

  async function loadVolume() {
    try {
      const r = await api("/api/volume", { method: "GET" });
      if (r && typeof r.volume === "number") { volValue = r.volume; renderVol(); }
    } catch (_) {}
  }

  function setVolumeAt(clientY) {
    const rect = npVolTrack.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, 1 - (clientY - rect.top) / Math.max(1, rect.height)));
    volValue = Math.round(ratio * 100);
    renderVol();
    if (volSendTimer) clearTimeout(volSendTimer);
    volSendTimer = setTimeout(() => {
      api("/api/volume", { method: "POST", body: { volume: volValue } }).catch(() => {});
    }, 130);
  }

  npVolTrack.addEventListener("pointerdown", (e) => {
    volDragging = true;
    dot.haptic();
    try { npVolTrack.setPointerCapture(e.pointerId); } catch (_) {}
    setVolumeAt(e.clientY);
  });
  npVolTrack.addEventListener("pointermove", (e) => { if (volDragging) setVolumeAt(e.clientY); });
  npVolTrack.addEventListener("pointerup", () => { volDragging = false; });
  npVolTrack.addEventListener("pointercancel", () => { volDragging = false; });
  npVol.addEventListener("pointerdown", (e) => e.stopPropagation());

  // ---------- coda (queue) ----------
  const npFullQueue = document.getElementById("npFullQueue");
  const npQueue = document.getElementById("npQueue");
  const npQueueList = document.getElementById("npQueueList");
  const nqMenu = document.getElementById("nqMenu");
  let queueItems = [];
  let queueIndex = -1;
  let queueLoaded = false;
  let queueRevision = 0;
  let queueLoadSerial = 0;
  let coverCurrentUrl = "";
  let coverFocusKey = "current";
  let coverItems = [];
  let coverCardNodes = new Map();
  let coverInfoTimer = null;
  let coverPointer = null;
  let coverSuppressClick = false;

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch (_) { return ""; }
  }

  function youtubeVideoId(url) {
    try {
      const parsed = new URL(url);
      let id = parsed.searchParams.get("v");
      if (!id && parsed.hostname.endsWith("youtu.be")) id = parsed.pathname.slice(1).split("/")[0];
      if (!id) {
        const match = parsed.pathname.match(/\/(?:embed|shorts)\/([A-Za-z0-9_-]{11})/);
        id = match ? match[1] : "";
      }
      return /^[A-Za-z0-9_-]{11}$/.test(id || "") ? id : "";
    } catch (_) { return ""; }
  }

  function youtubeThumbnail(url) {
    const id = youtubeVideoId(url);
    return id ? `https://img.youtube.com/vi/${id}/hqdefault.jpg` : "";
  }

  function sameMediaUrl(a, b) {
    const aVideo = youtubeVideoId(a);
    const bVideo = youtubeVideoId(b);
    if (aVideo || bVideo) return !!aVideo && aVideo === bVideo;
    try {
      const left = new URL(a);
      const right = new URL(b);
      return left.origin === right.origin && left.pathname === right.pathname && left.search === right.search;
    } catch (_) { return false; }
  }

  function currentQueueIndex() {
    if (!np.currentTrack || !np.currentTrack.url) return -1;
    if (queueIndex >= 0 && queueIndex < queueItems.length && sameMediaUrl(queueItems[queueIndex].url || "", np.currentTrack.url)) return queueIndex;
    return queueItems.findIndex((item) => sameMediaUrl(item.url || "", np.currentTrack.url));
  }

  function currentCoverKey() {
    const index = currentQueueIndex();
    return index >= 0 && queueItems[index].id ? queueItems[index].id : "current";
  }

  function queueCoverItem(item) {
    return {
      key: item.id,
      id: item.id,
      url: item.url || "",
      title: item.title || hostOf(item.url) || item.url || "MEDIA",
      site: hostOf(item.url),
      art: item.thumbnail || item.thumbnailUrl || item.art || youtubeThumbnail(item.url || ""),
      isCurrent: false,
    };
  }

  function getCoverItems() {
    if (!np.currentTrack) return [];
    const playingIndex = currentQueueIndex();
    const current = Object.assign({
      key: playingIndex >= 0 && queueItems[playingIndex].id ? queueItems[playingIndex].id : "current",
      id: null,
      isCurrent: true,
    }, np.currentTrack);
    const before = playingIndex >= 0 ? queueItems.slice(0, playingIndex) : [];
    const after = playingIndex >= 0 ? queueItems.slice(playingIndex + 1) : queueItems;
    return before.map(queueCoverItem).concat(current, after.map(queueCoverItem));
  }

  function selectedCoverItem() {
    return coverItems.find((item) => item.key === coverFocusKey) || coverItems[0] || null;
  }

  function updateCoverInfo(item) {
    if (!item) return;
    const title = item.title || "MEDIA";
    const site = item.site || item.url || "";
    const changed = npFullTitle.textContent !== title || npFullSite.textContent !== site;
    if (changed && np.fullOpen) {
      npFullInfo.classList.add("changing");
      clearTimeout(coverInfoTimer);
      coverInfoTimer = setTimeout(() => {
        npFullTitle.textContent = title;
        npFullSite.textContent = site;
        requestAnimationFrame(() => npFullInfo.classList.remove("changing"));
      }, 75);
    } else {
      npFullTitle.textContent = title;
      npFullSite.textContent = site;
      npFullInfo.classList.remove("changing");
    }
    const canPlay = !item.isCurrent && !!item.id;
    npPreviewPlay.hidden = !canPlay;
    npPreviewPlay.dataset.id = canPlay ? item.id : "";
  }

  function createCoverCard() {
    const card = h("button", { class: "np-cover-card", type: "button", tabindex: "0" });
    const image = h("img", { alt: "", draggable: "false", decoding: "async" });
    image.addEventListener("load", () => { image.dataset.failedSrc = ""; });
    image.addEventListener("error", () => {
      if (image.dataset.requestedSrc !== image.src) return;
      image.dataset.failedSrc = image.dataset.requestedArt;
      image.removeAttribute("src");
      card.classList.remove("has-art");
    });
    card.append(image);
    return card;
  }

  function renderCoverflow() {
    coverItems = getCoverItems();
    if (!coverItems.some((item) => item.key === coverFocusKey)) coverFocusKey = currentCoverKey();
    const focusIndex = Math.max(0, coverItems.findIndex((item) => item.key === coverFocusKey));
    const visible = new Map();
    for (let index = Math.max(0, focusIndex - COVERFLOW_MAX_DISTANCE); index <= Math.min(coverItems.length - 1, focusIndex + COVERFLOW_MAX_DISTANCE); index++) {
      visible.set(coverItems[index].key, { item: coverItems[index], index, offset: index - focusIndex });
    }

    const liveKeys = new Set(coverItems.map((item) => item.key));
    for (const [key, card] of coverCardNodes) {
      if (visible.has(key)) continue;
      coverCardNodes.delete(key);
      if (!liveKeys.has(key) && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        card.classList.add("is-exiting");
        card.classList.remove("is-current");
        card.tabIndex = -1;
        setTimeout(() => card.remove(), 220);
      } else card.remove();
    }
    for (const { item, index, offset } of visible.values()) {
      let card = coverCardNodes.get(item.key);
      if (!card) {
        card = createCoverCard();
        card.classList.add("is-entering");
        coverCardNodes.set(item.key, card);
        npCoverflowTrack.append(card);
        requestAnimationFrame(() => {
          npCoverflow.classList.add("ready");
          card.classList.remove("is-entering");
        });
      }
      const distance = Math.abs(offset);
      const side = Math.sign(offset);
      // COVERFLOW_* indicizzano scala, angolo e opacità per distanza; lo shift usa la larghezza della cover per adattarsi allo schermo.
      const thumb = item.art || "";
      const image = card.querySelector("img");
      if (thumb && image.getAttribute("src") !== thumb && image.dataset.failedSrc !== thumb) {
        image.loading = distance > 1 ? "lazy" : "eager";
        image.dataset.requestedArt = thumb;
        image.src = thumb;
        image.dataset.requestedSrc = image.src;
        card.classList.add("has-art");
      } else if (!thumb && image.hasAttribute("src")) {
        image.removeAttribute("src");
        card.classList.remove("has-art");
      }
      card.classList.toggle("is-current", item.isCurrent);
      card.classList.toggle("is-exiting", false);
      card.dataset.key = item.key;
      card.dataset.index = index;
      card.style.setProperty("--np-entry-x", `${side * 24}%`);
      card.setAttribute("aria-label", item.title || "MEDIA");
      card.style.setProperty("--np-distance", String(distance));
      card.style.transitionDelay = `${distance * 40}ms`;
      card.style.setProperty("--np-scale", String(COVERFLOW_SCALE[distance]));
      card.style.setProperty("--np-opacity", String(COVERFLOW_OPACITY[distance]));
      card.style.setProperty("--np-shade", String(COVERFLOW_SHADE[distance]));
      card.style.setProperty("--np-z", String(10 - distance));
      card.style.setProperty("--np-x", `${side * COVERFLOW_SPACING[distance] * 100}%`);
      card.style.setProperty("--np-rotate", `${-side * COVERFLOW_ROTATION[distance]}deg`);
    }

    npCoverflow.classList.toggle("solo", coverItems.length <= 1);
    updateCoverInfo(selectedCoverItem());
  }

  function focusCoverItem(key, keepDragX = false) {
    coverFocusKey = coverItems.some((item) => item.key === key) ? key : "current";
    if (!keepDragX) npCoverflowTrack.style.removeProperty("--np-drag-x");
    renderCoverflow();
  }

  function loadQueue() {
    const requestSerial = ++queueLoadSerial;
    const requestRevision = queueRevision;
    return api("/api/queue", { method: "GET" }).then((r) => {
      if (requestSerial !== queueLoadSerial || requestRevision !== queueRevision) return;
      queueItems = (r && Array.isArray(r.queue)) ? r.queue : [];
      queueIndex = r && typeof r.index === "number" ? r.index : -1;
      queueLoaded = true;
      renderQueue();
      renderCoverflow();
    }).catch(() => {});
  }

  npCoverflow.addEventListener("pointerdown", (e) => {
    if (npFull.classList.contains("queue") || (e.pointerType === "mouse" && e.button !== 0)) return;
    coverPointer = { id: e.pointerId, x: e.clientX, y: e.clientY, lastX: e.clientX, lastAt: performance.now(), velocity: 0, dragging: false };
  });
  npCoverflow.addEventListener("pointermove", (e) => {
    if (!coverPointer || e.pointerId !== coverPointer.id) return;
    const dx = e.clientX - coverPointer.x;
    const dy = e.clientY - coverPointer.y;
    if (!coverPointer.dragging && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      coverPointer.dragging = true;
      npCoverflow.classList.add("dragging");
      try { npCoverflow.setPointerCapture(e.pointerId); } catch (_) {}
    }
    if (!coverPointer.dragging) return;
    e.preventDefault();
    const now = performance.now();
    coverPointer.velocity = (e.clientX - coverPointer.lastX) / Math.max(1, now - coverPointer.lastAt);
    coverPointer.lastX = e.clientX;
    coverPointer.lastAt = now;
    npCoverflowTrack.style.setProperty("--np-drag-x", `${dx}px`);
  });
  function endCoverPointer(e) {
    if (!coverPointer || (e && e.pointerId !== coverPointer.id)) return;
    const gesture = coverPointer;
    coverPointer = null;
    npCoverflow.classList.remove("dragging");
    if (!gesture.dragging) {
      npCoverflowTrack.style.removeProperty("--np-drag-x");
      return;
    }
    coverSuppressClick = true;
    setTimeout(() => { coverSuppressClick = false; }, 80);
    const dx = (e && e.clientX != null ? e.clientX : gesture.lastX) - gesture.x;
    const moved = Math.abs(dx) >= COVERFLOW_SNAP_PX || (Math.abs(dx) > 18 && Math.abs(gesture.velocity) > 0.45);
    if (moved) {
      const index = Math.max(0, Math.min(coverItems.length - 1,
        coverItems.findIndex((item) => item.key === coverFocusKey) + (dx < 0 ? 1 : -1)));
      focusCoverItem(coverItems[index].key, true);
    } else renderCoverflow();
    npCoverflowTrack.style.setProperty("--np-drag-x", "0px");
  }
  npCoverflow.addEventListener("pointerup", endCoverPointer);
  npCoverflow.addEventListener("pointercancel", endCoverPointer);
  npCoverflow.addEventListener("click", (e) => {
    if (coverSuppressClick) { e.preventDefault(); return; }
    const card = e.target.closest(".np-cover-card");
    if (card) focusCoverItem(card.dataset.key);
  });
  npPreviewPlay.addEventListener("click", () => {
    if (npPreviewPlay.dataset.id) playQueueItem(npPreviewPlay.dataset.id);
  });

  function setFavicon(el, url) {
    const host = hostOf(url);
    if (host) {
      el.style.backgroundImage = "url(" + JSON.stringify("https://www.google.com/s2/favicons?domain=" + encodeURIComponent(host) + "&sz=128") + ")";
      el.classList.add("has-art");
    } else {
      el.style.backgroundImage = "";
      el.classList.remove("has-art");
    }
  }

  function renderQueue() {
    npQueueList.textContent = "";
    if (!queueItems.length) {
      npQueueList.append(h("div", { class: "nq-empty", text: "CODA VUOTA · AGGIUNGI LINK CON ⇱" }));
      return;
    }
    for (let n = 0; n < queueItems.length; n++) {
      const it = queueItems[n];
      const art = h("div", { class: "nq-art" });
      setFavicon(art, it.url);
      const host = hostOf(it.url);
      const title = it.title || host || it.url;
      const sub = it.title ? host : "IN CODA";
      const more = h("button", { class: "nq-more", type: "button", text: "⋯", "aria-label": "Opzioni" });
      more.addEventListener("click", (e) => { e.stopPropagation(); openNqMenu(more, it.id); });
      const item = h("div", { class: "nq-item" + (n === queueIndex ? " now" : "") },
        art,
        h("div", { class: "nq-text" }, h("div", { class: "nq-title", text: title }), h("div", { class: "nq-sub", text: sub })),
        more
      );
      item.addEventListener("click", () => playQueueItem(it.id));
      npQueueList.append(item);
    }
  }

  function hideNqMenu() { nqMenu.hidden = true; nqMenu.dataset.id = ""; }

  function openNqMenu(btn, id) {
    dot.haptic();
    nqMenu.dataset.id = id;
    nqMenu.hidden = false;
    const b = btn.getBoundingClientRect();
    const f = npFull.getBoundingClientRect();
    const mw = nqMenu.offsetWidth;
    const mh = nqMenu.offsetHeight;
    let top = b.bottom - f.top + 4;
    let right = f.right - b.right;
    if (top + mh > f.height - 8) top = Math.max(8, b.top - f.top - mh - 4);
    if (right + mw > f.width - 8) right = 8;
    nqMenu.style.top = top + "px";
    nqMenu.style.right = right + "px";
  }

  function toggleQueue() {
    if (np.queueClearing) { np.queueClearing = false; return; }
    dot.haptic();
    const on = !npFull.classList.contains("queue");
    npFull.classList.toggle("queue", on);
    if (on) focusCoverItem("current");
    npQueue.hidden = !on;
    npFullQueue.classList.toggle("active", on);
    if (on) { closeVol(); loadQueue(); }
    else hideNqMenu();
  }

  npFullQueue.addEventListener("click", toggleQueue);
  let queueClearTimer = null;
  const cancelQueueClear = () => { if (queueClearTimer) { clearTimeout(queueClearTimer); queueClearTimer = null; } };
  npFullQueue.addEventListener("pointerdown", () => {
    cancelQueueClear();
    queueClearTimer = setTimeout(async () => {
      queueClearTimer = null;
      np.queueClearing = true;
      try {
        const r = await api("/api/queue/clear", { method: "POST", body: {} });
        if (r && r.ok) {
          dot.toast("COME SVUOTATA");
          dot.haptic();
          if (!npQueue.hidden) renderQueue();
        }
      } catch (_) {}
    }, 5000);
  });
  npFullQueue.addEventListener("pointerup", cancelQueueClear);
  npFullQueue.addEventListener("pointerleave", cancelQueueClear);
  npFullQueue.addEventListener("pointercancel", cancelQueueClear);
  npQueueList.addEventListener("scroll", hideNqMenu);
  nqMenu.addEventListener("click", async (e) => {
    const btn = e.target.closest(".nq-menu-item");
    if (!btn) return;
    const act = btn.dataset.act;
    const id = nqMenu.dataset.id;
    hideNqMenu();
    if (!id) return;
    dot.haptic();
    try {
      if (act === "remove") await api("/api/queue/remove", { method: "POST", body: { id } });
      else await api("/api/queue/move", { method: "POST", body: { id, dir: act } });
      await loadQueue();
    } catch (err) { dot.toast("ERRORE: " + err.message.toUpperCase()); }
  });

  function applyNp(d) {
    const found = !!(d && d.found);
    np.found = found;

    if (!found && d && (d.reason === "permission" || d.reason === "no-browser")) {
      np.mode = "hint";
      np.paused = true;
      setNpIcons(true);
      npMini.classList.add("show");
      document.getElementById("cinema").classList.add("has-np");
      setArt(npMiniArt, "", "");
      npMiniTitle.textContent = d.reason === "no-browser" ? "SELEZIONA UN BROWSER SPECIFICO" : "ABILITA JS DA APPLE EVENTS";
      npMiniSub.textContent = "TOCCA PER LE IMPOSTAZIONI ⚙";
      npMiniPlay.style.visibility = "hidden";
      showHomeMini(false);
      return;
    }

    if (!found) {
      // durante il cambio brano (prev/succ/play) non smontiamo il player: ora
      // potrebbe essere momentaneamente non rilevato mentre il nuovo video si
      // carica, e altrimenti l'overlay "sparirebbe e ricomparirebbe"
      if (Date.now() >= np.navUntil) {
        np.mode = "none";
        np.url = "";
        np.ending = false;
        np.pendingNav = false;
        np.navUntil = 0;
        closeNpFull();
        npMini.classList.remove("show");
        document.getElementById("cinema").classList.remove("has-np");
        showHomeMini(false);
      }
      return;
    }

    np.mode = "media";
    np.paused = !!d.paused;
    np.current = Number(d.current) || 0;
    np.duration = Number(d.duration) || 0;
    const playingUrl = String(d.url || "");
    np.currentTrack = {
      url: playingUrl,
      title: d.title || "MEDIA",
      site: d.site || hostOf(playingUrl),
      art: d.art || "",
    };
    if (playingUrl !== coverCurrentUrl) {
      coverCurrentUrl = playingUrl;
      coverFocusKey = currentCoverKey();
    }

    npMini.classList.add("show");
    document.getElementById("cinema").classList.add("has-np");
    npMiniPlay.style.visibility = "";
    setNpIcons(np.paused);
    setArt(npMiniArt, d.art, d.site);
    npMiniTitle.textContent = d.title || "MEDIA";
    npMiniSub.textContent = fmtTime(np.current) + " / " + fmtTime(np.duration) + (d.site ? " · " + d.site : "");

    showHomeMini(true);
    if (homeMiniArt) setArt(homeMiniArt, d.art, d.site);
    setMiniTitle(d.title || "MEDIA");
    if (homeMiniSub) homeMiniSub.textContent = fmtTime(np.current) + " / " + fmtTime(np.duration) + (d.site ? " · " + d.site : "");

    renderCoverflow();
    npFullDur.textContent = fmtTime(np.duration);
    if (!np.scrubbing) {
      npFullCur.textContent = fmtTime(np.current);
      const pct = np.duration > 0 ? Math.min(100, (np.current / np.duration) * 100) : 0;
      npFullFill.style.width = pct + "%";
    }

    // autoplay: quando il video finisce passa al prossimo della coda
    const url = String(d.url || "");
    if (url !== np.url) {
      np.url = url;
      np.ending = false;
      np.pendingNav = false;
      np.navUntil = 0;
    }
    if (d.ended && np.next && !np.ending && !np.pendingNav) {
      np.ending = true;
      npQueueNext(true);
    }
  }

  async function pollNp() {
    if (!np.running || np.busy) return;
    if (document.hidden || !dot.online()) return;
    np.busy = true;
    try { applyNp(await api("/api/nowplaying", { method: "GET" })); } catch (_) {}
    np.busy = false;
    if (np.auto && np.found) api("/api/skip", { method: "POST", body: {} }).catch(() => {});
  }

  // polling adattivo sempre attivo: veloce in Cinema, lento in home (dove il
  // mini-player deve comunque accorgersi se qualcosa è in riproduzione)
  function npDelay() {
    if (np.cinema || np.fullOpen) return 1500;
    return np.found ? 4000 : 7000;
  }
  function npSchedule() {
    if (!np.running) return;
    clearTimeout(np.timer);
    np.timer = setTimeout(async () => { await pollNp(); npSchedule(); }, npDelay());
  }
  function startNp() {
    if (np.running) return;
    np.running = true;
    pollNp();
    npSchedule();
  }

  async function npToggle() {
    if (np.mode === "hint") { openSettingsSheet(); return; }
    if (!np.found) { pollNp(); return; }
    if (!ensureOnline()) return;
    dot.haptic();
    const newPaused = !np.paused;
    np.paused = newPaused;
    setNpIcons(newPaused);
    try { await api("/api/player", { method: "POST", body: { action: newPaused ? "pause" : "play" } }); } catch (_) {}
    pollNp();
  }

  function scrubRatio(clientX) {
    const rect = npFullTrack.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)));
  }

  function renderScrub(ratio) {
    const sec = ratio * (np.duration || 0);
    npFullFill.style.width = ratio * 100 + "%";
    if (npFullThumb) npFullThumb.style.left = ratio * 100 + "%";
    if (npSeekBubble) {
      npSeekBubble.style.left = ratio * 100 + "%";
      npSeekBubble.textContent = fmtTime(sec);
    }
    npFullCur.textContent = fmtTime(sec);
  }

  function scrubStart(e) {
    if (!np.found || !np.duration) return;
    np.scrubbing = true;
    dot.haptic();
    if (npScrub) npScrub.classList.add("scrubbing");
    try { npFullTrack.setPointerCapture(e.pointerId); } catch (_) {}
    renderScrub(scrubRatio(e.clientX));
  }
  function scrubMove(e) {
    if (!np.scrubbing) return;
    renderScrub(scrubRatio(e.clientX));
  }
  function scrubEnd(e) {
    if (!np.scrubbing) return;
    np.scrubbing = false;
    if (npScrub) npScrub.classList.remove("scrubbing");
    const sec = scrubRatio(e.clientX) * (np.duration || 0);
    api("/api/seek", { method: "POST", body: { seconds: sec } }).catch(() => {});
    setTimeout(pollNp, 250);
  }

  function npSeekBy(delta) {
    if (!np.found) return;
    if (!ensureOnline()) return;
    dot.haptic();
    const target = Math.max(0, np.duration > 0 ? Math.min(np.duration, np.current + delta) : np.current + delta);
    np.current = target;
    npFullCur.textContent = fmtTime(target);
    if (np.duration > 0) npFullFill.style.width = Math.min(100, (target / np.duration) * 100) + "%";
    api("/api/seek", { method: "POST", body: { delta } }).catch(() => {});
  }

  async function openAudioSheet() {
    dot.haptic();
    const list = h("div", { class: "cs-diag", text: "carico…" });
    openSheet(h("div", {}, sheetHead("USCITA AUDIO"), h("div", { class: "cs-label", text: "DISPOSITIVO" }), list));
    try {
      const r = await api("/api/audio/devices", { method: "GET" });
      state.audio = (r && r.devices) || [];
      list.className = "cs-audio";
      list.textContent = "";
      if (!state.audio.length) {
        list.className = "cs-diag";
        list.textContent = r && r.error ? "ERRORE · " + r.error : "NESSUN DISPOSITIVO DI OUTPUT";
        return;
      }
      for (const d of state.audio) {
        const row = h("button", { class: "cs-audio-item" + (d.default ? " active" : ""), type: "button" },
          h("span", { class: "cs-audio-name", text: d.name || ("Device " + d.id) }),
          h("span", { class: "cs-audio-tag", text: d.default ? "ATTIVO" : "" })
        );
        row.addEventListener("click", async () => {
          dot.haptic();
          try {
            await api("/api/audio/output", { method: "POST", body: { deviceId: d.id } });
            dot.toast("AUDIO · " + String(d.name || "").toUpperCase().slice(0, 18));
            openAudioSheet();
          } catch (e) { dot.toast("ERRORE: " + e.message.toUpperCase()); }
        });
        list.append(row);
      }
      render();
    } catch (e) {
      list.className = "cs-diag err";
      list.textContent = "ERRORE · " + e.message;
    }
  }

  async function npSkip() {
    if (!ensureOnline()) return;
    dot.haptic();
    try {
      const r = await api("/api/skip", { method: "POST", body: {} });
      if (r && r.clicked) dot.toast("SALTATO · " + String(r.clicked).toUpperCase().slice(0, 20));
      else if (r && r.ad) dot.toast("ANNUNCIO · MANDATO AVANTI");
      else dot.toast("NIENTE DA SALTARE");
    } catch (e) { dot.toast("ERRORE: " + e.message.toUpperCase()); }
  }

  // --- navigazione della coda ---
  async function npQueueNext(silent) {
    if (!ensureOnline()) return;
    beginNav();
    if (!silent) dot.haptic();
    try {
      const r = await api("/api/queue/next", { method: "POST", body: {} });
      if (r && r.opened) {
        np.url = r.opened.url || "";
        np.ending = false;
        np.pendingNav = true;
        if (!silent) dot.toast("PROSSIMO · " + hostOf(r.opened.url).toUpperCase());
        setTimeout(pollNp, 600);
      }
    } catch (e) {
      if (!silent) dot.toast("NIENTE IN CODA");
    }
  }

  // prec/succ: usa la coda dell'app se ha qualcosa, altrimenti il tasto media
  // di sistema (funziona a prescindere dalla coda, come la modale in home)
  async function npNav(dir) {
    if (!ensureOnline()) return;
    beginNav();
    dot.haptic();
    try {
      const r = await api("/api/queue/" + dir, { method: "POST", body: {} });
      if (r && r.opened) {
        np.url = r.opened.url || "";
        np.ending = false;
        np.pendingNav = true;
        dot.toast((dir === "next" ? "PROSSIMO · " : "PRECEDENTE · ") + hostOf(r.opened.url).toUpperCase());
        setTimeout(pollNp, 600);
        return;
      }
    } catch (_) {}
    if (dot.media) {
      dot.media(dir);
      dot.toast(dir === "next" ? "PROSSIMO" : "PRECEDENTE");
    }
  }

  async function playQueueItem(id) {
    if (!ensureOnline()) return;
    dot.haptic();
    try {
      const r = await api("/api/queue/play", { method: "POST", body: { id } });
      if (r && r.opened) {
        np.url = r.opened.url || "";
        np.ending = false;
        np.pendingNav = true;
        setTimeout(pollNp, 600);
      }
    } catch (e) { dot.toast("ERRORE: " + e.message.toUpperCase()); }
  }

  // --- toggle stile loop/shuffle ---
  let skipLongFired = false;
  let skipLongTimer = null;

  function npToggleSkip() {
    if (skipLongFired) { skipLongFired = false; return; } // era una pressione lunga (salta ora): niente toggle
    dot.haptic();
    np.auto = !np.auto;
    if (npFullSkip) npFullSkip.classList.toggle("active", np.auto);
    try { localStorage.setItem("dot_autoskip", np.auto ? "1" : "0"); } catch (_) {}
    dot.toast(np.auto ? "SALTA ANNUNCI ON" : "SALTA ANNUNCI OFF");
    if (np.auto) pollNp();
  }

  function npToggleAuto() {
    dot.haptic();
    np.next = !np.next;
    if (npFullAuto) npFullAuto.classList.toggle("active", np.next);
    try { localStorage.setItem("dot_autoplay", np.next ? "1" : "0"); } catch (_) {}
    dot.toast(np.next ? "AUTOPLAY ON" : "AUTOPLAY OFF");
  }

  // pressione lunga sul toggle salta → salta subito l'annuncio
  function skipPressStart() {
    skipLongFired = false;
    clearTimeout(skipLongTimer);
    skipLongTimer = setTimeout(() => { skipLongFired = true; npSkip(); }, 480);
  }
  function skipPressEnd() { clearTimeout(skipLongTimer); }

  npMini.addEventListener("click", (e) => {
    if (e.target.closest("#npMiniPlay")) return;
    if (np.mode === "hint") { openSettingsSheet(); return; }
    openNpFull();
  });
  npMiniPlay.addEventListener("click", (e) => { e.stopPropagation(); npToggle(); });
  npFullPlay.addEventListener("click", npToggle);
  npFullDown.addEventListener("click", closeNpFull);
  npFullAudio.addEventListener("click", toggleVol);
  npBack.addEventListener("click", () => npSeekBy(-5));
  npFwd.addEventListener("click", () => npSeekBy(5));
  npFullSkip.addEventListener("click", npToggleSkip);
  npFullAuto.addEventListener("click", npToggleAuto);
  npFullPrev.addEventListener("click", () => npNav("prev"));
  npFullNext.addEventListener("click", () => npNav("next"));
  if (homeMiniPlay) homeMiniPlay.addEventListener("click", (e) => { e.stopPropagation(); npToggle(); });
  if (homeMiniPrev) homeMiniPrev.addEventListener("click", (e) => { e.stopPropagation(); npNav("prev"); });
  if (homeMiniNext) homeMiniNext.addEventListener("click", (e) => { e.stopPropagation(); npNav("next"); });
  if (homeMini) homeMini.addEventListener("click", () => { if (np.mode === "media") openNpFull(); });
  npFullSkip.addEventListener("pointerdown", skipPressStart);
  npFullSkip.addEventListener("pointerup", skipPressEnd);
  npFullSkip.addEventListener("pointerleave", skipPressEnd);
  npFullSkip.addEventListener("pointercancel", skipPressEnd);
  npFullTrack.addEventListener("pointerdown", scrubStart);
  npFullTrack.addEventListener("pointermove", scrubMove);
  npFullTrack.addEventListener("pointerup", scrubEnd);
  npFullTrack.addEventListener("pointercancel", scrubEnd);
  npFull.addEventListener("click", (e) => {
    if (e.target === npFull) { closeNpFull(); return; }
    if (!e.target.closest(".nq-menu") && !e.target.closest(".nq-more")) hideNqMenu();
    if (!e.target.closest("#npVol") && !e.target.closest("#npFullAudio")) closeVol();
  });

  document.addEventListener("dot:cinema", (e) => {
    np.cinema = !!(e.detail && e.detail.open);
    if (np.cinema) { startNp(); pollNp(); }
    else { closeNpFull(); closeVol(); }
  });

  function displayBar() {
    return h("button", { class: "cine-bar", onclick: () => { dot.haptic(); openDisplaySheet(); } },
      h("span", { class: "cine-bar-k", text: "DISPLAY" }),
      h("span", { class: "cine-bar-v", text: currentDisplayLabel() }),
      h("span", { class: "cine-bar-caret", text: "›" })
    );
  }

  function currentDisplayLabel() {
    const idx = state.settings ? state.settings.displayIndex : state.target;
    if (idx == null) return "AUTO · ESTERNO";
    const d = state.displays.find((x) => x.index === idx);
    return d ? d.name : "#" + idx;
  }

  function tile(opts) {
    const iconWrap = h("span", { class: "tile-icon" });
    if (opts.folder) iconWrap.append(svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'));
    else iconWrap.append(iconNode(opts.icon));
    return h("button", { class: "tile" + (opts.dashed ? " tile-add" : ""), type: "button", onclick: opts.onclick },
      iconWrap, h("span", { class: "tile-label", text: opts.label }));
  }

  function moviesTile() {
    return tile({ label: "Cartella film", folder: true, onclick: () => { dot.haptic(); openMovies(""); } });
  }

  function bookmarkTile(bm) {
    const btn = tile({ label: bm.name, icon: bm.icon, onclick: () => openBookmark(bm) });
    attachLongPress(btn, () => openManageSheet(bm));
    return btn;
  }

  function addTile() {
    const iconWrap = h("span", { class: "tile-icon" }, svg('<path d="M12 5v14M5 12h14"/>', 1.8));
    return h("button", { class: "tile tile-add", type: "button", onclick: () => { dot.haptic(); openBookmarkForm(null); } },
      iconWrap, h("span", { class: "tile-label", text: "Aggiungi" }));
  }

  // long press -> gestione tile (modifica/elimina/riordina)
  function attachLongPress(el, fn) {
    let timer = null;
    let fired = false;
    const start = () => {
      fired = false;
      timer = setTimeout(() => { fired = true; dot.haptic(); fn(); }, 480);
    };
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    el.addEventListener("pointerdown", start);
    el.addEventListener("pointerup", cancel);
    el.addEventListener("pointerleave", cancel);
    el.addEventListener("pointercancel", cancel);
    el.addEventListener("click", (e) => {
      if (fired) { e.preventDefault(); e.stopPropagation(); fired = false; }
    }, true);
  }

  // ---------- azioni ----------
  async function openBookmark(bm) {
    if (!ensureOnline()) return;
    dot.haptic();
    dot.toast("APRO " + bm.name.toUpperCase() + "…");
    try {
      await api("/api/open", { method: "POST", body: { url: bm.url } });
      dot.toast("LANCIATO SUL MAC");
    } catch (e) {
      dot.toast("ERRORE: " + e.message.toUpperCase());
    }
  }

  function openBookmarkForm(bm) {
    let pendingIcon = bm && bm.icon && /^data:/.test(bm.icon) ? bm.icon : null;
    const nameI = h("input", { class: "cs-input", type: "text", placeholder: "nome", value: bm ? bm.name : "", autocapitalize: "off", autocorrect: "off", spellcheck: "false" });
    const urlI = h("input", { class: "cs-input", type: "url", placeholder: "https://…", value: bm ? bm.url : "", autocapitalize: "off", autocorrect: "off", spellcheck: "false" });
    const iconI = h("input", { class: "cs-input", type: "text", placeholder: "emoji (facoltativo)", maxlength: "4", value: bm && bm.icon && !/^data:/.test(bm.icon) ? bm.icon : "" });

    const favBtn = h("button", { class: "cs-chip", text: "SCARICA FAVICON", onclick: async () => {
      const u = urlI.value.trim();
      if (!u) { dot.toast("INSERISCI UN URL"); return; }
      dot.toast("SCARICO…");
      try {
        const r = await api("/api/favicon", { method: "POST", body: { url: u } });
        if (r.icon) { pendingIcon = r.icon; dot.toast("FAVICON OK"); }
        else dot.toast("FAVICON NON TROVATA");
      } catch (e) { dot.toast("ERRORE FAVICON"); }
    }});

    const save = async () => {
      const name = nameI.value.trim();
      const url = urlI.value.trim();
      const icon = pendingIcon || iconI.value.trim();
      if (!name || !url) { dot.toast("NOME E URL RICHIESTI"); return; }
      try {
        if (bm) await api("/api/bookmarks/" + bm.id, { method: "PATCH", body: { name, url, icon } });
        else await api("/api/bookmarks", { method: "POST", body: { name, url, icon } });
        closeSheet();
        dot.toast("SALVATO");
        load();
      } catch (e) { dot.toast("ERRORE: " + e.message.toUpperCase()); }
    };

    openSheet(h("div", {},
      sheetHead(bm ? "MODIFICA" : "NUOVO BOOKMARK"),
      h("div", { class: "cs-label", text: "NOME" }), nameI,
      h("div", { class: "cs-label", text: "URL" }), urlI,
      h("div", { class: "cs-label", text: "ICONA" }), iconI, favBtn,
      h("button", { class: "cs-primary", text: bm ? "SALVA" : "AGGIUNGI", onclick: save })
    ));
  }

  function openManageSheet(bm) {
    const idx = () => state.bookmarks.findIndex((x) => x.id === bm.id);
    openSheet(h("div", {},
      sheetHead(bm.name),
      h("div", { class: "cs-list" },
        h("button", { class: "cs-row", text: "MODIFICA", onclick: () => openBookmarkForm(bm) }),
        h("div", { class: "cs-move" },
          h("button", { class: "cs-chip", text: "← SPOSTA", onclick: () => moveBookmark(idx(), -1) }),
          h("button", { class: "cs-chip", text: "SPOSTA →", onclick: () => moveBookmark(idx(), 1) })
        ),
        h("button", { class: "cs-row danger", text: "ELIMINA", onclick: async () => {
          try { await api("/api/bookmarks/" + bm.id, { method: "DELETE" }); closeSheet(); dot.toast("ELIMINATO"); load(); }
          catch (e) { dot.toast("ERRORE"); }
        }})
      )
    ));
  }

  async function moveBookmark(idx, dir) {
    if (idx < 0) return;
    const order = state.bookmarks.map((x) => x.id);
    const j = idx + dir;
    if (j < 0 || j >= order.length) return;
    [order[idx], order[j]] = [order[j], order[idx]];
    try {
      await api("/api/bookmarks/reorder", { method: "POST", body: { order } });
      closeSheet();
      load();
    } catch (e) { dot.toast("ERRORE"); }
  }

  // ---------- display di destinazione ----------
  async function openDisplaySheet() {
    try {
      const r = await api("/api/displays");
      state.displays = r.displays || [];
      state.target = r.target;
    } catch (_) {}
    const list = h("div", { class: "cs-list" });
    list.append(displayRow(null, "AUTO · ESTERNO"));
    for (const d of state.displays) {
      const tag = d.main ? " · MAIN" : d.builtin ? "" : " · ESTERNO";
      list.append(displayRow(d.index, d.name + tag, d.w + "×" + d.h));
    }
    if (!state.displays.length) list.append(h("div", { class: "cs-empty", text: "NESSUN DISPLAY (HELPER OFFLINE?)" }));
    openSheet(h("div", {}, sheetHead("DISPLAY DI DESTINAZIONE"), list));
  }

  function displayRow(index, label, sub) {
    const active = (state.target == null && index == null) || state.target === index;
    return h("button", { class: "cs-row" + (active ? " active" : ""), onclick: async () => {
      try {
        await api("/api/settings", { method: "POST", body: { displayIndex: index } });
        if (state.settings) state.settings.displayIndex = index;
        state.target = index;
        closeSheet();
        render();
        dot.toast("DISPLAY AGGIORNATO");
      } catch (e) { dot.toast("ERRORE"); }
    }},
      h("span", { class: "cs-row-t", text: label }),
      sub ? h("span", { class: "cs-row-s", text: sub }) : null
    );
  }

  // ---------- cartella film ----------
  function upPath(p) {
    const i = p.lastIndexOf("/");
    return i < 0 ? "" : p.slice(0, i);
  }

  async function openMovies(path) {
    let data;
    try {
      data = await api("/api/files?path=" + encodeURIComponent(path || ""));
    } catch (e) {
      dot.toast("ERRORE: " + e.message.toUpperCase());
      return;
    }
    const list = h("div", { class: "cs-list" });
    for (const it of data.items) {
      if (it.dir) list.append(h("button", { class: "cs-row", onclick: () => openMovies(it.path) },
        h("span", { class: "cs-row-t", text: "▸ " + it.name })));
      else if (it.video) list.append(h("button", { class: "cs-row", onclick: () => playFile(it.path) },
        h("span", { class: "cs-row-t", text: it.name })));
      else list.append(h("div", { class: "cs-row muted" }, h("span", { class: "cs-row-t", text: it.name })));
    }
    if (!data.items.length) list.append(h("div", { class: "cs-empty", text: "CARTELLA VUOTA" }));
    openSheet(h("div", {},
      sheetHead(data.path ? data.path : "CARTELLA FILM", data.path ? () => openMovies(upPath(data.path)) : null),
      list
    ));
  }

  async function playFile(filePath) {
    if (!ensureOnline()) return;
    dot.haptic();
    try {
      await api("/api/play", { method: "POST", body: { path: filePath } });
      closeSheet();
      dot.toast("RIPRODUZIONE SUL MAC");
    } catch (e) {
      dot.toast("ERRORE: " + e.message.toUpperCase());
    }
  }

  // ---------- impostazioni ----------
  function openSettingsSheet() {
    const s = state.settings || {};
    const browserRow = h("div", { class: "cs-chips" });
    for (const b of s.browsers || ["chrome", "safari"]) {
      browserRow.append(h("button", { class: "cs-chip" + (s.browser === b ? " active" : ""), text: b.toUpperCase(), onclick: () => setSetting({ browser: b }) }));
    }
    const playerRow = h("div", { class: "cs-chips" });
    for (const p of ["auto", "iina", "vlc", "quicktime"]) {
      playerRow.append(h("button", { class: "cs-chip" + (s.player === p ? " active" : ""), text: p.toUpperCase(), onclick: () => setSetting({ player: p }) }));
    }
    const rootI = h("input", { class: "cs-input", type: "text", value: s.moviesRoot || "", autocapitalize: "off", autocorrect: "off", spellcheck: "false" });

    const diagOut = h("div", { class: "cs-diag" });
    const diagBtn = h("button", { class: "cs-chip", text: "TESTA CONTROLLO PLAYER", onclick: async () => {
      diagOut.textContent = "…";
      diagOut.className = "cs-diag";
      try {
        const d = await api("/api/nowplaying", { method: "GET" });
        if (d.found) {
          diagOut.textContent = "OK · " + (d.title || "media") + " (" + fmtTime(d.current) + " / " + fmtTime(d.duration) + ")";
          diagOut.classList.add("ok");
        } else if (d.reason === "permission") {
          diagOut.textContent = "PERMESSO NEGATO · " + (d.error || "abilita JS da Apple Events e il controllo (Automazione)");
          diagOut.classList.add("err");
        } else if (d.reason === "no-browser") {
          diagOut.textContent = "NESSUNA TAB · scegli un browser specifico qui sopra";
          diagOut.classList.add("err");
        } else if (d.reason === "no-window") {
          diagOut.textContent = "OK (permesso) · nessuna finestra aperta nel browser";
          diagOut.classList.add("ok");
        } else {
          diagOut.textContent = "NESSUN MEDIA NELLA TAB ATTIVA (" + (d.browser || "?") + ")";
        }
      } catch (e) { diagOut.textContent = "ERRORE · " + e.message; diagOut.classList.add("err"); }
    }});

    const skipOut = h("div", { class: "cs-diag" });
    const skipBtn = h("button", { class: "cs-chip", text: "TESTA SALTA ANNUNCIO", onclick: async () => {
      skipOut.textContent = "…";
      skipOut.className = "cs-diag";
      try {
        const r = await api("/api/skip", { method: "POST", body: {} });
        if (!r.ok) { skipOut.textContent = "ERRORE · " + (r.error || r.reason); skipOut.classList.add("err"); return; }
        skipOut.textContent = "CLICKED: " + (r.clicked || "null") + " · ANNUNCIO: " + (r.ad ? "SÌ" : "no") + (r.error ? " · " + r.error : "");
        skipOut.classList.add(r.clicked || r.ad ? "ok" : "");
      } catch (e) { skipOut.textContent = "ERRORE · " + e.message; skipOut.classList.add("err"); }
    }});

    openSheet(h("div", {},
      sheetHead("IMPOSTAZIONI"),
      h("div", { class: "cs-label", text: "BROWSER" }), browserRow,
      h("div", { class: "cs-label", text: "PLAYER" }), playerRow,
      h("div", { class: "cs-label", text: "CARTELLA FILM (SUL MAC)" }), rootI,
      h("button", { class: "cs-primary", text: "SALVA CARTELLA", onclick: async () => {
        try {
          state.settings = await api("/api/settings", { method: "POST", body: { moviesRoot: rootI.value.trim() } });
          render();
          dot.toast("SALVATO");
        } catch (e) { dot.toast("ERRORE: " + e.message.toUpperCase()); }
      }}),
      h("div", { class: "cs-label", text: "DIAGNOSI PLAYER" }), diagBtn, diagOut,
      h("div", { class: "cs-label", text: "DIAGNOSI SALTA ANNUNCIO" }), skipBtn, skipOut
    ));
  }

  async function setSetting(patch) {
    try {
      state.settings = await api("/api/settings", { method: "POST", body: patch });
      openSettingsSheet();
    } catch (e) { dot.toast("ERRORE"); }
  }

  // ---------- caricamento ----------
  async function load() {
    try {
      const [b, s] = await Promise.all([api("/api/bookmarks"), api("/api/settings")]);
      state.bookmarks = b.bookmarks || [];
      state.settings = s;
      state.target = s.displayIndex;
      state.loaded = true;
      render();
      api("/api/displays")
        .then((r) => { state.displays = r.displays || []; render(); })
        .catch(() => {});
      api("/api/audio/devices")
        .then((r) => { state.audio = (r && r.devices) || []; render(); })
        .catch(() => {});
    } catch (e) {
      bodyEl.textContent = "";
      bodyEl.append(h("div", { class: "cine-empty", text: "CARICAMENTO FALLITO · " + e.message.toUpperCase() }));
    }
  }

  // ---------- eventi ----------
  settingsBtn.addEventListener("click", () => { dot.haptic(); openSettingsSheet(); });
  document.addEventListener("dot:status", applyOffline);

  // aggiornamenti live dal server (SSE) inoltrati da app.js
  document.addEventListener("dot:server", (e) => {
    const msg = e.detail;
    if (!msg) return;
    if (msg.type === "bookmarks" && Array.isArray(msg.bookmarks)) {
      state.bookmarks = msg.bookmarks;
      if (state.loaded && !sheetIsOpen) render();
    } else if (msg.type === "settings" && msg.settings) {
      state.settings = msg.settings;
      state.target = msg.settings.displayIndex;
    } else if (msg.type === "displays" && Array.isArray(msg.displays)) {
      state.displays = msg.displays;
    } else if (msg.type === "queue" && Array.isArray(msg.queue)) {
      queueRevision++;
      queueItems = msg.queue;
      queueIndex = typeof msg.index === "number" ? msg.index : -1;
      queueLoaded = true;
      if (!npQueue.hidden) renderQueue();
      renderCoverflow();
      if (msg.autoplay && msg.queue.length) {
        np.next = true;
        if (npFullAuto) npFullAuto.classList.add("active");
        dot.toast("PLAYLIST IN CODA · AUTOPLAY ON");
      }
    } else if (msg.type === "nowplaying") {
      applyNp(msg.nowplaying || msg.data || msg);
    }
  });

  load();
  startNp();
})();
