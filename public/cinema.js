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

  const token = dot.token();
  const state = {
    bookmarks: [],
    settings: null,
    displays: [],
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
    const head = h("div", { class: "cine-sec-head" }, h("strong", { text: "01 / COSA GUARDIAMO?" }));
    const grid = h("div", { class: "tile-grid" });
    grid.append(moviesTile());
    for (const bm of state.bookmarks) grid.append(bookmarkTile(bm));
    grid.append(addTile());
    return h("section", { class: "cine-sec" }, head, displayBar(), grid);
  }

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
      }})
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
    }
  });

  load();
})();
