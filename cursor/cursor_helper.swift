import CoreGraphics
import Foundation
import ApplicationServices
import AppKit
import CoreAudio

let displayBounds = CGDisplayBounds(CGMainDisplayID())

// Desktop virtuale: unione dei bounds di tutti gli display attivi, nelle
// coordinate globali Quartz (tengono conto della disposizione scelta in
// Sistema→Schermi). Ricalcolato a ogni use: hot-plug e riordino schermi
// funzionano senza riavviare l'helper.
func desktopBounds() -> CGRect {
    var count: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &count)
    guard count > 0 else { return displayBounds }
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetActiveDisplayList(count, &ids, &count)
    var union = CGRect.null
    for id in ids.prefix(Int(count)) {
        union = union.union(CGDisplayBounds(id))
    }
    return union.isNull ? displayBounds : union
}

func isTrusted() -> Bool {
    let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    let opts = [key: true] as CFDictionary
    return AXIsProcessTrustedWithOptions(opts)
}

// stampa una riga JSON su stdout (protocollo verso il server Node)
func emit(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj),
       let line = String(data: data, encoding: .utf8) {
        print(line)
        fflush(stdout)
    }
}

func move(nx: Double, ny: Double) {
    let bounds = desktopBounds()
    let point = CGPoint(x: bounds.origin.x + max(0, min(1, nx)) * bounds.width,
                        y: bounds.origin.y + max(0, min(1, ny)) * bounds.height)
    guard let ev = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
                           mouseCursorPosition: point, mouseButton: .left) else { return }
    ev.post(tap: .cghidEventTap)
}

func click(button: String) {
    let type: CGMouseButton = button == "right" ? .right : .left
    let down: CGEventType = button == "right" ? .rightMouseDown : .leftMouseDown
    let up: CGEventType = button == "right" ? .rightMouseUp : .leftMouseUp
    let point = CGEvent(source: nil)?.location ?? .zero
    guard let d = CGEvent(mouseEventSource: nil, mouseType: down,
                          mouseCursorPosition: point, mouseButton: type),
          let u = CGEvent(mouseEventSource: nil, mouseType: up,
                          mouseCursorPosition: point, mouseButton: type) else { return }
    d.post(tap: .cghidEventTap)
    u.post(tap: .cghidEventTap)
}

func doubleClick(button: String) {
    let type: CGMouseButton = button == "right" ? .right : .left
    let down: CGEventType = button == "right" ? .rightMouseDown : .leftMouseDown
    let up: CGEventType = button == "right" ? .rightMouseUp : .leftMouseUp
    let point = CGEvent(source: nil)?.location ?? .zero
    for state in 1...2 {
        guard let d = CGEvent(mouseEventSource: nil, mouseType: down,
                              mouseCursorPosition: point, mouseButton: type),
              let u = CGEvent(mouseEventSource: nil, mouseType: up,
                              mouseCursorPosition: point, mouseButton: type) else { return }
        d.setIntegerValueField(.mouseEventClickState, value: Int64(state))
        u.setIntegerValueField(.mouseEventClickState, value: Int64(state))
        d.post(tap: .cghidEventTap)
        u.post(tap: .cghidEventTap)
        if state == 1 { usleep(50000) }
    }
}

func scroll(dx: Double, dy: Double) {
    guard let ev = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
                           wheel1: Int32(-dy.rounded()), wheel2: Int32(-dx.rounded()), wheel3: 0) else { return }
    ev.post(tap: .cghidEventTap)
}

func typeText(_ text: String) {
    for ch in text {
        var utf16 = Array(String(ch).utf16)
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { continue }
        down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
        up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }
}

let keyCodes: [String: CGKeyCode] = [
    "return": 36, "tab": 48, "space": 49, "escape": 53, "delete": 117,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "w": 13, "q": 12, "s": 1, "z": 9, "t": 17, "r": 15, "n": 45, "f": 3,
]

func pressKey(name: String, command: Bool, control: Bool = false) {
    guard let code = keyCodes[name] else { return }
    let src = CGEventSource(stateID: .combinedSessionState)
    var flags: CGEventFlags = []
    if command { flags.insert(.maskCommand) }
    if control { flags.insert(.maskControl) }
    guard let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false) else { return }
    down.flags = flags
    up.flags = flags
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
}

let mediaKeys: [String: Int32] = [
    "volup": 0, "voldown": 1, "mute": 7, "play": 16, "next": 17, "prev": 18,
]

func mediaKey(_ name: String) {
    guard let key = mediaKeys[name] else { return }
    for down in [true, false] {
        let data1 = Int(key) << 16 | ((down ? 0x0a : 0x0b) << 8)
        if let ev = NSEvent.otherEvent(with: .systemDefined, location: .zero,
                                       modifierFlags: [], timestamp: 0,
                                       windowNumber: 0, context: nil,
                                       subtype: 8, data1: data1, data2: -1) {
            ev.cgEvent?.post(tap: .cghidEventTap)
        }
        usleep(20000)
    }
}

// MARK: - MediaRemote: comandi di riproduzione
//
// Da macOS 15.4 mediaremoted nega la LETTURA dell'info "in riproduzione"
// ai processi terzi (servono gli entitlement com.apple.mediaremote.*),
// quindi quella passa da /usr/bin/osascript (vedi nowplaying.applescript).
// I COMANDI invece funzionano anche da un processo terzo: qui si usano
// direttamente MRMediaRemoteSendCommand / MRMediaRemoteSetElapsedTime,
// caricati con dlsym così l'helper compila e parte anche senza il framework.
// Nessun permesso di Automazione richiesto (niente Apple Events).

private let mrHandle = dlopen("/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote", RTLD_LAZY)

// MRCommand: 0 play, 1 pause, 2 toggle, 3 stop, 4 next, 5 previous,
// 18 skip backward, 19 skip forward (intervallo in userInfo con la
// chiave kMRMediaRemoteOptionSkipInterval — testato su Music.app; il
// supporto è per-app: Music accetta solo lo skip indietro)
private let mrCommandCodes: [String: Int] = [
    "play": 0, "pause": 1, "toggle": 2, "next": 4, "prev": 5,
    "skipback": 18, "skipfwd": 19,
]

// Su macOS 26 il simbolo è la plain MRMediaRemoteSendCommand (quella
// WithOptions non esiste più): comandi e userInfo passano lo stesso.
// I comandi arrivano all'app "in riproduzione" corrente di MediaRemote:
// se a suonare è un browser, i comandi MediaRemote li ignora (l'utente
// li aveva letti come "non funziona") — per quello il player web si
// comanda via JS e quello di sistema via mrcommand.
func mrSendCommand(_ code: Int, interval: Double? = nil) -> Bool? {
    guard let h = mrHandle, let p = dlsym(h, "MRMediaRemoteSendCommand") else { return nil }
    typealias Fn = @convention(c) (Int, UnsafeMutableRawPointer?) -> Bool
    var info: CFDictionary?
    if let iv = interval, iv > 0 {
        // le chiavi di MediaRemote sono il nome della costante stessa
        info = ["kMRMediaRemoteOptionSkipInterval": NSNumber(value: iv)] as CFDictionary
    }
    let raw = info.map { UnsafeMutableRawPointer(Unmanaged.passUnretained($0).toOpaque()) }
    return unsafeBitCast(p, to: Fn.self)(code, raw)
}

func mrSetElapsedTime(_ seconds: Double) -> Bool? {
    guard let h = mrHandle, let p = dlsym(h, "MRMediaRemoteSetElapsedTime") else { return nil }
    typealias Fn = @convention(c) (Double) -> Void
    unsafeBitCast(p, to: Fn.self)(max(0, seconds))
    return true
}

// MARK: - Cursore (mostra/nascondi) per la modalità proiettore

func setCursorVisible(_ visible: Bool) {
    if visible {
        CGDisplayShowCursor(CGMainDisplayID())
    } else {
        CGDisplayHideCursor(CGMainDisplayID())
    }
}

// MARK: - Display (multi-monitor)

// Elenco schermi. NSScreen usa coordinate Cocoa con origine in basso a sinistra,
// mentre AX (per spostare le finestre) usa l'origine in alto a sinistra sul
// display principale: qui convertiamo sull'altezza del main screen.
func screenList() -> [[String: Any]] {
    let screens = NSScreen.screens
    let primaryH = screens.first?.frame.height ?? 0
    var out: [[String: Any]] = []
    for (i, s) in screens.enumerated() {
        let f = s.frame
        var builtin = false
        if let num = s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber {
            builtin = CGDisplayIsBuiltin(num.uint32Value) != 0
        }
        out.append([
            "index": i,
            "name": s.localizedName,
            "x": Double(f.origin.x),
            "y": Double(primaryH - (f.origin.y + f.height)),
            "w": Double(f.width),
            "h": Double(f.height),
            "main": f.origin == .zero,
            "builtin": builtin,
        ])
    }
    return out
}

// display di destinazione: indice esplicito, altrimenti il primo esterno,
// altrimenti il principale.
func targetScreen(index: Int?) -> [String: Any]? {
    let list = screenList()
    if let i = index, i >= 0, i < list.count { return list[i] }
    if let ext = list.first(where: { ($0["builtin"] as? Bool) == false }) { return ext }
    return list.first
}

// Finestra focalizzata di una data applicazione (nil se assente).
func focusedWindow(_ pid: pid_t) -> AXUIElement? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid),
                                        kAXFocusedWindowAttribute as CFString, &v) == .success,
          let v else { return nil }
    return (v as! AXUIElement)
}

// La finestra su cui agire: se noto il bundle id lo cerco per primo (così non
// rischio di spostare la finestra di un'altra app se il frontmostApplication
// non è ancora aggiornato), altrimenti uso quella in primo piano.
func axWindow(forBundle bundleId: String?) -> AXUIElement? {
    if let b = bundleId,
       let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == b }),
       let w = focusedWindow(app.processIdentifier) {
        return w
    }
    if let app = NSWorkspace.shared.frontmostApplication,
       bundleId == nil || app.bundleIdentifier == bundleId {
        return focusedWindow(app.processIdentifier)
    }
    return nil
}

func axPoint(_ w: AXUIElement, _ attr: String) -> CGPoint? {
    var pv: CFTypeRef?
    guard AXUIElementCopyAttributeValue(w, attr as CFString, &pv) == .success, let pv else { return nil }
    var pt = CGPoint.zero
    AXValueGetValue(pv as! AXValue, .cgPoint, &pt)
    return pt
}

// true se la finestra è già sul display di destinazione e in schermo intero
// come richiesto: in quel caso non si tocca nulla (niente flicker, niente attese).
// NB: in schermo intero macOS riporta la posizione con l'offset della barra dei
// menu (es. y=33), non (0,0): confrontare le coordinate farebbe fallire sempre
// il test e il loop di moveFrontWindow continuerebbe a uscire/rientrare (il
// "mette e toglie" a ripetizione). In fullscreen quindi si verifica solo che la
// finestra copra il display target.
func windowAlreadyOnTarget(_ win: AXUIElement, x: Double, y: Double, fullscreen: Bool) -> Bool {
    guard let p = axPoint(win, kAXPositionAttribute as String) else { return false }
    let fs = (winAttr(win, "AXFullScreen") as? Bool) == true
    if fullscreen && fs {
        // fullscreen: la posizione non è affidabile; basta che il punto target
        // (angolo del display scelto) non sia a sinistra/sopra la finestra.
        return p.x <= CGFloat(x) + 4
    }
    return abs(p.x - CGFloat(x)) < 2 && abs(p.y - CGFloat(y)) < 2 && fs == fullscreen
}

// L'uscita dallo schermo intero è asincrona (~0.75s) e quando finisce la
// finestra torna al vecchio frame: bisogna aspettare davvero, altrimenti lo
// spostamento che segue verrebbe cancellato.
func exitFullScreen(_ win: AXUIElement) {
    AXUIElementSetAttributeValue(win, "AXFullScreen" as CFString, kCFBooleanFalse)
    for _ in 0..<30 {
        if (winAttr(win, "AXFullScreen") as? Bool) != true { return }
        Thread.sleep(forTimeInterval: 0.1)
    }
}

// Sposta la finestra sul display scelto e, se richiesto, la porta a schermo
// intero nativo (AXFullScreen). Richiede il permesso Accessibilità.
// Chromium/Arc ignorano a volte il cambio di posizione quando la finestra è
// già in schermo intero: si prova quindi a spostare così com'è e, se non
// regge, si esce dallo schermo intero, si sposta e si rientra. Le operazioni
// AX sono asincrone, quindi ogni passo viene verificato.
func moveFrontWindow(displayIndex: Int?, fullscreen: Bool, bundleId: String? = nil) {
    guard let scr = targetScreen(index: displayIndex) else { return }
    let tx = scr["x"] as? Double ?? 0
    let ty = scr["y"] as? Double ?? 0
    let tw = scr["w"] as? Double ?? 0
    let th = scr["h"] as? Double ?? 0
    func apply(_ win: AXUIElement) {
        var p = CGPoint(x: tx, y: ty)
        var s = CGSize(width: tw, height: th)
        if let pv = AXValueCreate(.cgPoint, &p) {
            AXUIElementSetAttributeValue(win, kAXPositionAttribute as CFString, pv)
        }
        if let sv = AXValueCreate(.cgSize, &s) {
            AXUIElementSetAttributeValue(win, kAXSizeAttribute as CFString, sv)
        }
    }
    for _ in 0..<3 {
        guard let win = axWindow(forBundle: bundleId) else {
            Thread.sleep(forTimeInterval: 0.25); continue
        }
        if windowAlreadyOnTarget(win, x: tx, y: ty, fullscreen: fullscreen) { return }
        let isFs = (winAttr(win, "AXFullScreen") as? Bool) == true
        if isFs {
            // già in schermo intero: per spostarla su un altro display bisogna
            // uscirne (macOS non accetta un semplice set della posizione).
            // Se invece la vogliamo fullscreen, è sufficiente: niente da fare.
            if fullscreen { return }
            exitFullScreen(win)
        }
        // sposta/ridimensiona sul display scelto (finestra non fullscreen)
        apply(win)
        Thread.sleep(forTimeInterval: 0.2)
        if fullscreen {
            // entra in schermo intero UNA volta e non riapplicare la posizione:
            // in fullscreen la posizione è gestita da macOS con l'offset della
            // barra dei menu, e un secondo set() farebbe uscire/rientrare.
            AXUIElementSetAttributeValue(win, "AXFullScreen" as CFString, kCFBooleanTrue)
            Thread.sleep(forTimeInterval: 0.4)
            if let w2 = axWindow(forBundle: bundleId),
               windowAlreadyOnTarget(w2, x: tx, y: ty, fullscreen: true) { return }
        }
        if let p = axPoint(win, kAXPositionAttribute as String),
           abs(p.x - CGFloat(tx)) < 2 && abs(p.y - CGFloat(ty)) < 2 {
            return
        }
        Thread.sleep(forTimeInterval: 0.25)
    }
}

func winAttr(_ w: AXUIElement, _ attr: String) -> CFTypeRef? {
    var v: CFTypeRef?
    AXUIElementCopyAttributeValue(w, attr as CFString, &v)
    return v
}

// true se la finestra dell'app indicata è già in schermo intero: serve per
// spostarla senza costringerla a uscire e rientrare.
func arcIsFullscreen(_ bundleId: String?) -> Bool {
    guard let win = axWindow(forBundle: bundleId) else { return false }
    return (winAttr(win, "AXFullScreen") as? Bool) == true
}

// Entra/esce dallo schermo intero nativo (AXFullScreen) della finestra focale,
// senza ridimensionarla. Se l'AX fallisce, come fallback invia ⌃⌘F (shortcut di
// sistema per lo schermo intero).
func setFrontWindowFullscreen(_ on: Bool) {
    var applied = false
    if let app = NSWorkspace.shared.frontmostApplication {
        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        var winRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, &winRef) == .success,
           let winVal = winRef {
            let win = winVal as! AXUIElement
            var cur: CFTypeRef?
            AXUIElementCopyAttributeValue(win, "AXFullScreen" as CFString, &cur)
            if (cur as? Bool) != on {
                applied = AXUIElementSetAttributeValue(win, "AXFullScreen" as CFString, on ? kCFBooleanTrue : kCFBooleanFalse) == .success
            } else {
                applied = true
            }
        }
    }
    if applied { return }
    print("fullscreen AX fallito, fallback ⌃⌘F")
    let (ok, _) = runAppleScript(
        "tell application \"System Events\" to key code 3 using {control down, command down}"
    )
    if !ok { print("fullscreen fallback ⌃⌘F fallito") }
}

// apre un URL in un browser specifico, poi sposta/mette a schermo intero la
// finestra sul display di destinazione (dopo un breve ritardo, il tempo che la
// finestra compaia).
// browser supportati: "default" usa il handler di sistema; gli altri mappano a un
// bundle id. Arc/Brave/Edge/Chrome sono tutti basati su Chromium e condividono
// la stessa interfaccia AppleScript per l'iniezione di JavaScript.
// NB: l'bundle id di Arc è "company.thebrowser.Browser" (senza il "com." iniziale):
// con l'id sbagliato urlForApplication ritorna nil e si finisce nel fallback del
// browser di default, che ignora sia la scelta del browser sia il display.
let browserBundleIDs: [String: String] = [
    "chrome": "com.google.Chrome",
    "arc": "company.thebrowser.Browser",
    "brave": "com.brave.Browser",
    "edge": "com.microsoft.edgemac",
    "firefox": "org.mozilla.firefox",
    "safari": "com.apple.Safari",
]

// Apre l'URL come nuova tab selezionata nella finestra Arc corrente. Serve a
// evitare che Air Traffic Control ("most recent space") instradi il link verso
// una Space con molte tab pinnate, che Arc ricaricherebbe tutte. Ritorna false
// se Arc non ha finestre aperte (in quel caso si usa il comportamento normale).
func openURLInArcTab(_ urlString: String) -> Bool {
    let esc = escapeAppleScript(urlString)
    let source = """
    tell application "Arc"
        if (count of windows) is 0 then return "0"
        tell front window
            set newTab to make new tab with properties {URL:"\(esc)"}
            try
                select newTab
            end try
        end tell
        activate
        return "1"
    end tell
    """
    let (ok, res) = runAppleScript(source)
    return ok && res.trimmingCharacters(in: .whitespacesAndNewlines) == "1"
}

func openURLInBrowser(_ urlString: String, browser: String, displayIndex: Int?, fullscreen: Bool) {
    guard let url = URL(string: urlString) else { return }
    // "default": lascia che macOS apra l'URL con il browser predefinito
    if browser == "default" {
        NSWorkspace.shared.open(url)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            moveFrontWindow(displayIndex: displayIndex, fullscreen: fullscreen)
        }
        return
    }
    guard let bundle = browserBundleIDs[browser],
          let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) else {
        // browser richiesto non installato: fallback al browser di default
        NSWorkspace.shared.open(url)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            moveFrontWindow(displayIndex: displayIndex, fullscreen: fullscreen)
        }
        return
    }
    // Arc: apri come tab nella finestra corrente per non passare da Air Traffic
    // Control. La finestra è già stata spostata sul display di destinazione dal
    // chiamante (case "openurl"), qui resta solo da applicare lo schermo intero.
    if browser == "arc", openURLInArcTab(urlString) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            moveFrontWindow(displayIndex: displayIndex, fullscreen: fullscreen, bundleId: bundle)
        }
        return
    }
    // NSWorkspace.open da un tool CLI senza bundle non lancia in modo affidabile
    // il browser quando è chiuso (il completion handler non scatta). Si usa
    // quindi /usr/bin/open -a <app>, che funziona sempre.
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    p.arguments = ["-a", appURL.path, urlString]
    do {
        try p.run()
    } catch {
        NSWorkspace.shared.open(url)
    }
    // l'app può metterci un attimo a comparire: retry più lunghi, e la finestra
    // viene spostata/messa in fullscreen una sola volta da moveFrontWindow
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
        moveFrontWindow(displayIndex: displayIndex, fullscreen: fullscreen, bundleId: bundle)
    }
}

// naviga la tab attiva del browser (riusandola) invece di aprire una nuova
// tab/finestra: così il video precedente viene scaricato e non continua a
// suonare in sottofondo. Ritorna true se la navigazione è andata a buon fine.
func navigateTabInBrowser(_ urlString: String, browser: String) -> Bool {
    let esc = escapeAppleScript(urlString)
    let source: String
    if browser == "safari" {
        source = """
        tell application "Safari"
            if (count of windows) is 0 then return ""
            set URL of current tab of window 1 to "\(esc)"
            return "1"
        end tell
        """
    } else if let appName = browserAppleScriptName[browser] {
        source = """
        tell application "\(appName)"
            if (count of windows) is 0 then return ""
            set URL of active tab of window 1 to "\(esc)"
            return "1"
        end tell
        """
    } else {
        return false
    }
    let (ok, res) = runAppleScript(source)
    return ok && res.trimmingCharacters(in: .whitespacesAndNewlines) == "1"
}

// MARK: - AppleScript / iniezione JavaScript nei browser
//
// Nota permessi: l'helper gira come figlio del terminale/Node, quindi macOS
// attribuisce il permesso "Automazione" al processo che lo avvia. Serve
// consentire il controllo di Chrome/Safari (e System Events) da quel processo.

func escapeAppleScript(_ s: String) -> String {
    return s.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
}

// Esegue l'AppleScript wrappato in `with timeout of N seconds`: una tab
// scartata di Arc (o un dialogo di permesso in attesa) può lasciare la
// chiamata Apple Events sospesa per sempre e, senza scadenza, bloccherebbe
// l'intera coda dei comandi dell'helper (bug già capitato con il primo
// contatto con Arc). NSAppleScript va eseguito sul main thread.
func runAppleScript(_ source: String, timeoutSec: Int = 10) -> (Bool, String) {
    let wrapped = "with timeout of \(timeoutSec) seconds\n\(source)\nend timeout"
    var error: NSDictionary?
    if let script = NSAppleScript(source: wrapped) {
        let out = script.executeAndReturnError(&error)
        if let err = error {
            let msg = (err[NSAppleScript.errorMessage] as? String) ?? "errore AppleScript"
            return (false, msg)
        }
        return (true, out.stringValue ?? "")
    }
    return (false, "compilazione AppleScript fallita")
}

// Esegue JS nella tab attiva del browser indicato e ne restituisce il risultato.
// nome applicazione per l'AppleScript (i browser Chromium si chiamano così)
let browserAppleScriptName: [String: String] = [
    "chrome": "Google Chrome",
    "arc": "Arc",
    "brave": "Brave Browser",
    "edge": "Microsoft Edge",
]

func execJSInBrowser(browser: String, js: String, tabIndex: Int? = nil) -> (Bool, String) {
    let escaped = escapeAppleScript(js)
    if browser == "safari" {
        // tabIndex consente di raggiungere una tab di secondo piano (come su
        // Chromium): senza, si opera sempre sulla tab corrente
        let tabPart = tabIndex.map { "tab \($0) of front window" } ?? "current tab of front window"
        let source = """
        tell application "Safari"
            if (count of windows) is 0 then return ""
            do JavaScript "\(escaped)" in \(tabPart)
        end tell
        """
        return runAppleScript(source)
    }
    guard let appName = browserAppleScriptName[browser] else {
        return (false, "browser non supportato per l'iniezione JS (usa Safari, Chrome, Arc, Brave o Edge)")
    }
    let tabPart = tabIndex.map { "tab \($0) of front window" } ?? "front window's active tab"
    let source = """
    tell application "\(appName)"
        if (count of windows) is 0 then return ""
        execute \(tabPart) javascript "\(escaped)"
    end tell
    """
    return runAppleScript(source)
}

// Scorre le tab della front window alla ricerca di una che sta suonando e ci
// esegue probe: restituisce l'indice della prima tab con media in
// riproduzione ("2"), o in extremis la prima in pausa ("1"). Serve quando il
// media sta in una tab di secondo piano (pinned tab, es. Spotify/YouTube) e
// non nella attiva. Chromium ha la proprietà "audible" (probe solo su quelle);
// Safari no, quindi prova ogni tab con do JavaScript.
func findMediaTab(browser: String, probe: String) -> Int? {
    guard browser == "safari" || browserAppleScriptName[browser] != nil else { return nil }
    let escaped = escapeAppleScript(probe)
    let source: String
    if browser == "safari" {
        source = """
        tell application "Safari"
            if (count of windows) is 0 then return ""
            set n to count of tabs of front window
            set firstPause to 0
            repeat with i from 1 to n
                try
                    set r to (do JavaScript "\(escaped)" in tab i of front window)
                    if r contains "2" then return (i as text)
                    if (r contains "1") and firstPause is 0 then set firstPause to i
                end try
            end repeat
            if firstPause > 0 then return (firstPause as text)
        end tell
        return ""
        """
    } else {
        source = """
        tell application "\(browserAppleScriptName[browser] ?? "")"
            if (count of windows) is 0 then return ""
            set n to count of tabs of front window
            set firstPause to 0
            repeat with i from 1 to n
                try
                    if (audible of tab i of front window) then
                        set r to (execute tab i of front window javascript "\(escaped)")
                        if r contains "2" then return (i as text)
                        if (r contains "1") and firstPause is 0 then set firstPause to i
                    end if
                end try
            end repeat
            if firstPause > 0 then return (firstPause as text)
        end tell
        return ""
        """
    }
    let (ok, res) = runAppleScript(source, timeoutSec: 15)
    guard ok else { return nil }
    return Int(res.trimmingCharacters(in: .whitespacesAndNewlines))
}

// MARK: - Arc: media in tab di secondo piano
//
// Arc (dictionary AppleScript custom, non Chromium) esegue JS **solo** sulla
// tab attiva: `execute tab i ...` su qualsiasi altra tab resta in hang.
// Per raggiungere una tab di secondo piano si usa quindi la sequenza
// select → execute sulla attiva → ripristino della tab precedente (via id).

// Esegue js su una tab di secondo piano di Arc identificata da id (UUID),
// selezionandola temporaneamente e ripristinando quella attiva prima del ritorno.
func execJSInArcTab(tabId: String, js: String) -> (Bool, String) {
    let escaped = escapeAppleScript(js)
    let tid = escapeAppleScript(tabId)
    // Opera solo nella Space corrente: selezionare una tab di un'altra Space
    // farebbe cambiare Space ad Arc, che ricaricherebbe tutte le tab pinnate.
    let source = """
    tell application "Arc"
        if (count of windows) is 0 then return ""
        tell front window
            set curId to ((id of active tab) as text)
            repeat with s in spaces
                set i to 0
                set hasCur to false
                set targetIdx to -1
                set prevIdx to -1
                repeat with t in tabs of s
                    set i to i + 1
                    set cid to ((id of t) as text)
                    if cid is curId then
                        set hasCur to true
                        set prevIdx to i
                    end if
                    if cid is "\(tid)" then set targetIdx to i
                end repeat
                if hasCur then
                    if targetIdx < 0 then return ""
                    select tab targetIdx of s
                    set r to (execute front window's active tab javascript "\(escaped)")
                    if prevIdx > 0 then select tab prevIdx of s
                    return r
                end if
            end repeat
            return ""
        end tell
    end tell
    """
    // scan id + execute + ripristino in un unico script: serve più fiato
    return runAppleScript(source, timeoutSec: 12)
}

struct ArcMediaHit {
    let tabId: String
    let result: String
}

// Cerca su Arc una tab (titolo che combacia con pattern, max 8 candidati)
// che abbia un elemento media, la seleziona, ci esegue full e ripristina.
// Restituisce nil se nessuna tab ha media. Il titolo si legge senza JS, per
// questo si filtra prima: danzare su tutte le tab sarebbe insostenibile.
func findMediaTabArc(probe: String, full: String, pattern: String) -> ArcMediaHit? {
    // Scansiona SOLO la Space corrente: selezionare le tab di un'altra Space
    // farebbe cambiare Space ad Arc, che ricaricherebbe tutti i bookmark/pin.
    let scan = """
    tell application "Arc"
        if (count of windows) is 0 then return ""
        tell front window
            set curId to ((id of active tab) as text)
            repeat with si from 1 to (count of spaces)
                set s to space si
                set i to 0
                set hasCur to false
                set prevIdx to -1
                set outp to ""
                repeat with t in tabs of s
                    set i to i + 1
                    set cid to ((id of t) as text)
                    if cid is curId then
                        set hasCur to true
                        set prevIdx to i
                    end if
                    set outp to outp & i & "%%" & cid & "%%" & (title of t) & linefeed
                end repeat
                if hasCur then
                    return (si as text) & "@@@" & (prevIdx as text) & "@@@" & outp
                end if
            end repeat
            return ""
        end tell
    end tell
    """
    let (ok, res) = runAppleScript(scan, timeoutSec: 25)
    guard ok else { return nil }
    let parts = res.components(separatedBy: "@@@")
    guard parts.count >= 3, let spIdx = Int(parts[0]), let prevIdx = Int(parts[1]) else { return nil }
    var candidates: [(idx: Int, id: String)] = []
    let rx = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
    for line in parts[2].split(separator: "\n", omittingEmptySubsequences: true) {
        let seg = line.components(separatedBy: "%%")
        guard seg.count >= 3, let idx = Int(seg[0]) else { continue }
        let title = seg[2...].joined(separator: "%%")
        let range = NSRange(title.startIndex..., in: title)
        if rx?.firstMatch(in: title, options: [], range: range) != nil {
            candidates.append((idx, seg[1]))
        }
        if candidates.count >= 8 { break }
    }
    let probeEsc = escapeAppleScript(probe)
    let fullEsc = escapeAppleScript(full)
    func runFull(_ idx: Int) -> (Bool, String) {
        let d = """
        tell application "Arc"
            tell front window
                set s to space \(spIdx)
                select tab \(idx) of s
                set r to (execute front window's active tab javascript "\(fullEsc)")
                if \(prevIdx) > 0 then select tab \(prevIdx) of s
                return r
            end tell
        end tell
        """
        return runAppleScript(d, timeoutSec: 7)
    }
    var pausedHit: (idx: Int, id: String)? = nil
    for c in candidates {
        // probe: "0" niente, "1" media in pausa, "2" in riproduzione — la
        // riproduzione ha la precedenza: una tab vecchia in pausa (es.
        // pagina YouTube abbandonata) non deve sovrascrivere il media che
        // sta suonando da un'altra parte
        let dance = """
        tell application "Arc"
            tell front window
                set s to space \(spIdx)
                select tab \(c.idx) of s
                set p to (execute front window's active tab javascript "\(probeEsc)")
                if p contains "2" then
                    set r to (execute front window's active tab javascript "\(fullEsc)")
                    if \(prevIdx) > 0 then select tab \(prevIdx) of s
                    return r
                end if
                if p contains "1" then
                    if \(prevIdx) > 0 then select tab \(prevIdx) of s
                    return "PAUSA"
                end if
                if \(prevIdx) > 0 then select tab \(prevIdx) of s
                return ""
            end tell
        end tell
        """
        let (dok, dres) = runAppleScript(dance, timeoutSec: 7)
        if dok && dres == "PAUSA" {
            if pausedHit == nil { pausedHit = c }
        } else if dok && !dres.isEmpty {
            return ArcMediaHit(tabId: c.id, result: dres)
        }
    }
    // nessuna tab in riproduzione tra i candidati: usa la prima in pausa
    if let p = pausedHit {
        let (rok, rres) = runFull(p.idx)
        if rok && !rres.isEmpty {
            return ArcMediaHit(tabId: p.id, result: rres)
        }
    }
    return nil
}

// MARK: - Uscita audio (CoreAudio)
//
// Elenca i dispositivi di output e imposta quello di sistema (default output).
// Non richiede permessi speciali. Si usa l'elemento 0 (Main/Master) per evitare
// dipendenze dalla versione dell'SDK.

let kAOMainElement: AudioObjectPropertyElement = 0

func audioAddress(_ selector: AudioObjectPropertySelector,
                  _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    return AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAOMainElement)
}

func audioCFString(_ id: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> String {
    var addr = audioAddress(selector)
    var cf: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    let st = AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &cf)
    if st == noErr, let cf = cf { return cf.takeRetainedValue() as String }
    return ""
}

func audioHasOutput(_ id: AudioDeviceID) -> Bool {
    var addr = audioAddress(kAudioDevicePropertyStreamConfiguration, kAudioObjectPropertyScopeOutput)
    var size: UInt32 = 0
    if AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) != noErr || size == 0 { return false }
    let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { raw.deallocate() }
    if AudioObjectGetPropertyData(id, &addr, 0, nil, &size, raw) != noErr { return false }
    let abl = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
    var channels = 0
    for buf in abl { channels += Int(buf.mNumberChannels) }
    return channels > 0
}

func audioDefaultOutput() -> AudioDeviceID {
    var addr = audioAddress(kAudioHardwarePropertyDefaultOutputDevice)
    var dev = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &dev)
    return dev
}

func audioDeviceIDs() -> [AudioDeviceID] {
    var addr = audioAddress(kAudioHardwarePropertyDevices)
    var size: UInt32 = 0
    if AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) != noErr { return [] }
    let count = Int(size) / MemoryLayout<AudioDeviceID>.size
    var ids = [AudioDeviceID](repeating: 0, count: count)
    if AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) != noErr { return [] }
    return ids
}

func audioOutputs() -> [[String: Any]] {
    let def = audioDefaultOutput()
    var out: [[String: Any]] = []
    for id in audioDeviceIDs() where audioHasOutput(id) {
        out.append([
            "id": Int(id),
            "uid": audioCFString(id, kAudioDevicePropertyDeviceUID),
            "name": audioCFString(id, kAudioDevicePropertyDeviceNameCFString),
            "default": id == def,
        ])
    }
    return out
}

func setDefaultOutput(_ id: AudioDeviceID) -> Bool {
    var addr = audioAddress(kAudioHardwarePropertyDefaultOutputDevice)
    var dev = id
    let st = AudioObjectSetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil,
                                        UInt32(MemoryLayout<AudioDeviceID>.size), &dev)
    return st == noErr
}

// Volume di sistema dell'uscita attiva (0..100). Usa gli Standard Additions di
// AppleScript ("set volume"), che agiscono sull'uscita corrente senza permessi
// di Automazione aggiuntivi.
func getSystemVolume() -> Int {
    let (ok, res) = runAppleScript("output volume of (get volume settings)")
    if ok, let v = Int(res.trimmingCharacters(in: .whitespacesAndNewlines)) {
        return max(0, min(100, v))
    }
    return -1
}

func setSystemVolume(_ v: Int) -> Bool {
    let clamped = max(0, min(100, v))
    let (ok, _) = runAppleScript("set volume output volume \(clamped)")
    return ok
}

struct Command: Decodable {
    let cmd: String
    let id: Int?
    let x: Double?
    let y: Double?
    let dx: Double?
    let dy: Double?
    let button: String?
    let text: String?
    let key: String?
    let command: Bool?
    let control: Bool?
    let url: String?
    let browser: String?
    let displayIndex: Int?
    let fullscreen: Bool?
    let reuseTab: Bool?
    let source: String?
    let js: String?
    let tabIndex: Int?
    let tabId: String?
    let full: String?
    let pattern: String?
    let visible: Bool?
    let deviceId: Int?
    let volume: Int?
    let seconds: Double?
    let interval: Double?
}

let trusted = isTrusted()
let desk = desktopBounds()
emit([
    "type": "helper",
    "trusted": trusted,
    "display": ["x": displayBounds.origin.x, "y": displayBounds.origin.y,
                "w": displayBounds.width, "h": displayBounds.height],
    "desktop": ["x": desk.origin.x, "y": desk.origin.y,
                "w": desk.width, "h": desk.height],
    "displays": screenList(),
])

let stdin = FileHandle.standardInput
var buffer = Data()
stdin.readabilityHandler = { handle in
    let chunk = handle.availableData
    if chunk.isEmpty {
        exit(0)
    }
    buffer.append(chunk)
    while let nl = buffer.firstIndex(of: UInt8(ascii: "\n")) {
        let lineData = buffer.subdata(in: buffer.startIndex..<nl)
        buffer.removeSubrange(buffer.startIndex...nl)
        guard let cmd = try? JSONDecoder().decode(Command.self, from: lineData) else { continue }
        switch cmd.cmd {
        case "move":
            if let x = cmd.x, let y = cmd.y { move(nx: x, ny: y) }
        case "click":
            click(button: cmd.button ?? "left")
        case "doubleclick":
            doubleClick(button: cmd.button ?? "left")
        case "scroll":
            scroll(dx: cmd.dx ?? 0, dy: cmd.dy ?? 0)
        case "text":
            if let text = cmd.text { typeText(text) }
        case "key":
            if let key = cmd.key { pressKey(name: key, command: cmd.command ?? false, control: cmd.control ?? false) }
        case "media":
            if let key = cmd.key { mediaKey(key) }
        case "cursor":
            DispatchQueue.main.async { setCursorVisible(cmd.visible ?? true) }
        case "displays":
            DispatchQueue.main.async {
                emit(["type": "reply", "id": cmd.id ?? 0, "ok": true, "data": screenList()])
            }
        case "openurl":
            if let url = cmd.url {
                let reuse = cmd.reuseTab ?? false
                let browser = cmd.browser ?? "chrome"
                let displayIndex = cmd.displayIndex
                let fullscreen = cmd.fullscreen ?? true
                DispatchQueue.main.async {
                    // Arc riusa sempre la finestra già aperta (sia che crei la
                    // tab sia che riusi quella attiva): va spostata PRIMA,
                    // altrimenti la pagina appare sul display sbagliato e poi
                    // salta su quello giusto.
                    if browser == "arc" {
                        let bundleId = browserBundleIDs[browser]
                        moveFrontWindow(displayIndex: displayIndex,
                                        fullscreen: arcIsFullscreen(bundleId),
                                        bundleId: bundleId)
                    }
                    if reuse && navigateTabInBrowser(url, browser: browser) {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                            moveFrontWindow(displayIndex: displayIndex, fullscreen: fullscreen,
                                            bundleId: browserBundleIDs[browser])
                        }
                    } else {
                        openURLInBrowser(url, browser: browser,
                                         displayIndex: displayIndex, fullscreen: fullscreen)
                    }
                }
            }
            emit(["type": "reply", "id": cmd.id ?? 0, "ok": true])
        case "movefront":
            DispatchQueue.main.async {
                moveFrontWindow(displayIndex: cmd.displayIndex, fullscreen: cmd.fullscreen ?? false)
            }
            emit(["type": "reply", "id": cmd.id ?? 0, "ok": true])
        case "fullscreen":
            let target = cmd.fullscreen ?? true
            DispatchQueue.main.async {
                setFrontWindowFullscreen(target)
            }
            emit(["type": "reply", "id": cmd.id ?? 0, "ok": true])
        case "applescript":
            if let source = cmd.source {
                DispatchQueue.main.async {
                    let (ok, res) = runAppleScript(source)
                    emit(["type": "reply", "id": cmd.id ?? 0, "ok": ok, "result": res])
                }
            } else {
                emit(["type": "reply", "id": cmd.id ?? 0, "ok": false, "error": "source mancante"])
            }
        case "execjs":
            if let js = cmd.js {
                let tabIndex = cmd.tabIndex
                let tabId = cmd.tabId
                let browser = cmd.browser ?? "chrome"
                DispatchQueue.main.async {
                    // Arc: JS solo sulla tab attiva → su una tab di secondo
                    // piano (id) serve la danza select/ripristino
                    if browser == "arc", let tabId = tabId {
                        let (ok, res) = execJSInArcTab(tabId: tabId, js: js)
                        emit(["type": "reply", "id": cmd.id ?? 0, "ok": ok, "result": res])
                    } else {
                        let (ok, res) = execJSInBrowser(browser: browser, js: js, tabIndex: tabIndex)
                        emit(["type": "reply", "id": cmd.id ?? 0, "ok": ok, "result": res])
                    }
                }
            } else {
                emit(["type": "reply", "id": cmd.id ?? 0, "ok": false, "error": "js mancante"])
            }
        case "findmediatab":
            let browser = cmd.browser ?? "chrome"
            let probe = cmd.js ?? "1"
            let full = cmd.full ?? ""
            let pattern = cmd.pattern ?? ""
            DispatchQueue.main.async {
                if browser == "arc" {
                    if let hit = findMediaTabArc(probe: probe, full: full, pattern: pattern) {
                        emit(["type": "reply", "id": cmd.id ?? 0, "ok": true, "tabId": hit.tabId, "result": hit.result])
                    } else {
                        emit(["type": "reply", "id": cmd.id ?? 0, "ok": false, "error": "nessuna tab con media"])
                    }
                } else if let idx = findMediaTab(browser: browser, probe: probe) {
                    let (_, res) = execJSInBrowser(browser: browser, js: full, tabIndex: idx)
                    emit(["type": "reply", "id": cmd.id ?? 0, "ok": true, "tabIndex": idx, "result": res])
                } else {
                    emit(["type": "reply", "id": cmd.id ?? 0, "ok": false, "error": "nessuna tab con media"])
                }
            }
        case "mrcommand":
            // comandi MediaRemote sul player di sistema (Spotify, Music, VLC,
            // ...): nessun Apple Events, quindi nessun permesso da concedere
            let key = cmd.key ?? "toggle"
            let seconds = cmd.seconds ?? 0
            DispatchQueue.main.async {
                var ok = false
                var err: String? = nil
                if key == "seek" {
                    let r = mrSetElapsedTime(seconds)
                    ok = r == true
                    if r == nil { err = "MediaRemote non disponibile" }
                } else if let code = mrCommandCodes[key] {
                    let r = mrSendCommand(code, interval: cmd.interval)
                    ok = r == true
                    if r == nil { err = "MediaRemote non disponibile" }
                } else {
                    err = "comando sconosciuto"
                }
                var out: [String: Any] = ["type": "reply", "id": cmd.id ?? 0, "ok": ok]
                if let e = err { out["error"] = e }
                emit(out)
            }
        case "audiolist":
            DispatchQueue.main.async {
                emit(["type": "reply", "id": cmd.id ?? 0, "ok": true, "data": audioOutputs()])
            }
        case "audioset":
            if let deviceId = cmd.deviceId {
                DispatchQueue.main.async {
                    let ok = setDefaultOutput(AudioDeviceID(deviceId))
                    if ok {
                        emit(["type": "reply", "id": cmd.id ?? 0, "ok": true])
                    } else {
                        emit(["type": "reply", "id": cmd.id ?? 0, "ok": false, "error": "impossibile impostare l'uscita"])
                    }
                }
            } else {
                emit(["type": "reply", "id": cmd.id ?? 0, "ok": false, "error": "deviceId mancante"])
            }
        case "volumeget":
            DispatchQueue.main.async {
                let v = getSystemVolume()
                emit(["type": "reply", "id": cmd.id ?? 0, "ok": v >= 0, "volume": v])
            }
        case "volumeset":
            if let volume = cmd.volume {
                DispatchQueue.main.async {
                    let ok = setSystemVolume(volume)
                    emit(["type": "reply", "id": cmd.id ?? 0, "ok": ok])
                }
            } else {
                emit(["type": "reply", "id": cmd.id ?? 0, "ok": false, "error": "volume mancante"])
            }
        default:
            break
        }
    }
}

RunLoop.main.run()
