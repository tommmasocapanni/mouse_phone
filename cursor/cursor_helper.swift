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

struct Command: Decodable {
    let cmd: String
    let x: Double?
    let y: Double?
    let dx: Double?
    let dy: Double?
    let button: String?
    let text: String?
    let key: String?
    let command: Bool?
    let control: Bool?
}

let trusted = isTrusted()
let hello: [String: Any] = [
    "type": "helper",
    "trusted": trusted,
    "display": ["x": displayBounds.origin.x, "y": displayBounds.origin.y,
                "w": displayBounds.width, "h": displayBounds.height],
]
if let data = try? JSONSerialization.data(withJSONObject: hello),
   let line = String(data: data, encoding: .utf8) {
    print(line)
    fflush(stdout)
}

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
        default:
            break
        }
    }
}

RunLoop.main.run()
