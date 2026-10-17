import CoreGraphics
import Foundation
import ApplicationServices
import AppKit

let displayBounds = CGDisplayBounds(CGMainDisplayID())

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
    let point = CGPoint(x: displayBounds.origin.x + max(0, min(1, nx)) * displayBounds.width,
                        y: displayBounds.origin.y + max(0, min(1, ny)) * displayBounds.height)
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
    "w": 13, "q": 12, "t": 17, "r": 15, "n": 45, "f": 3,
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

// Sposta la finestra in primo piano sul display scelto e, se richiesto, la porta
// a schermo intero nativo (AXFullScreen). Richiede il permesso Accessibilità.
func moveFrontWindow(displayIndex: Int?, fullscreen: Bool) {
    guard let scr = targetScreen(index: displayIndex),
          let app = NSWorkspace.shared.frontmostApplication else { return }
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    var winRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, &winRef) == .success,
          let winVal = winRef else { return }
    let win = winVal as! AXUIElement
    let x = scr["x"] as? Double ?? 0
    let y = scr["y"] as? Double ?? 0
    let w = scr["w"] as? Double ?? 0
    let h = scr["h"] as? Double ?? 0
    var pos = CGPoint(x: x, y: y)
    var size = CGSize(width: w, height: h)
    if let pv = AXValueCreate(.cgPoint, &pos) {
        AXUIElementSetAttributeValue(win, kAXPositionAttribute as CFString, pv)
    }
    if let sv = AXValueCreate(.cgSize, &size) {
        AXUIElementSetAttributeValue(win, kAXSizeAttribute as CFString, sv)
    }
    if fullscreen {
        var cur: CFTypeRef?
        AXUIElementCopyAttributeValue(win, "AXFullScreen" as CFString, &cur)
        if (cur as? Bool) != true {
            AXUIElementSetAttributeValue(win, "AXFullScreen" as CFString, kCFBooleanTrue)
        }
    }
}

// apre un URL in un browser specifico, poi sposta/mette a schermo intero la
// finestra sul display di destinazione (dopo un breve ritardo, il tempo che la
// finestra compaia).
// browser supportati: "default" usa il handler di sistema; gli altri mappano a un
// bundle id. Arc/Brave/Edge/Chrome sono tutti basati su Chromium e condividono
// la stessa interfaccia AppleScript per l'iniezione di JavaScript.
let browserBundleIDs: [String: String] = [
    "chrome": "com.google.Chrome",
    "arc": "com.company.thebrowser.Browser",
    "brave": "com.brave.Browser",
    "edge": "com.microsoft.edgemac",
    "firefox": "org.mozilla.firefox",
    "safari": "com.apple.Safari",
]

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
        return
    }
    let cfg = NSWorkspace.OpenConfiguration()
    cfg.activates = true
    NSWorkspace.shared.open([url], withApplicationAt: appURL, configuration: cfg) { _, _ in
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            moveFrontWindow(displayIndex: displayIndex, fullscreen: fullscreen)
        }
    }
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

func runAppleScript(_ source: String) -> (Bool, String) {
    var error: NSDictionary?
    if let script = NSAppleScript(source: source) {
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

func execJSInBrowser(browser: String, js: String) -> (Bool, String) {
    let escaped = escapeAppleScript(js)
    if browser == "safari" {
        let source = """
        tell application "Safari"
            if (count of windows) is 0 then return ""
            do JavaScript "\(escaped)" in current tab of front window
        end tell
        """
        return runAppleScript(source)
    }
    guard let appName = browserAppleScriptName[browser] else {
        return (false, "browser non supportato per l'iniezione JS (usa Safari, Chrome, Arc, Brave o Edge)")
    }
    let source = """
    tell application "\(appName)"
        if (count of windows) is 0 then return ""
        execute front window's active tab javascript "\(escaped)"
    end tell
    """
    return runAppleScript(source)
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
    let source: String?
    let js: String?
    let visible: Bool?
}

let trusted = isTrusted()
emit([
    "type": "helper",
    "trusted": trusted,
    "display": ["x": displayBounds.origin.x, "y": displayBounds.origin.y,
                "w": displayBounds.width, "h": displayBounds.height],
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
                DispatchQueue.main.async {
                    openURLInBrowser(url, browser: cmd.browser ?? "chrome",
                                     displayIndex: cmd.displayIndex, fullscreen: cmd.fullscreen ?? true)
                }
            }
            emit(["type": "reply", "id": cmd.id ?? 0, "ok": true])
        case "movefront":
            DispatchQueue.main.async {
                moveFrontWindow(displayIndex: cmd.displayIndex, fullscreen: cmd.fullscreen ?? false)
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
                DispatchQueue.main.async {
                    let (ok, res) = execJSInBrowser(browser: cmd.browser ?? "chrome", js: js)
                    emit(["type": "reply", "id": cmd.id ?? 0, "ok": ok, "result": res])
                }
            } else {
                emit(["type": "reply", "id": cmd.id ?? 0, "ok": false, "error": "js mancante"])
            }
        default:
            break
        }
    }
}

RunLoop.main.run()
