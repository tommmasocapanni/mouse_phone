import AppKit
import Foundation

let size = 180
let out = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    .appendingPathComponent("public/icon.png")

guard let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: size, pixelsHigh: size,
    bitsPerSample: 8, samplesPerPixel: 4,
    hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0, bitsPerPixel: 0) else {
    fatalError("impossibile creare il bitmap")
}

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

let s = CGFloat(size)
let bg = NSColor(srgbRed: 0xfb / 255.0, green: 0xfb / 255.0, blue: 0xfa / 255.0, alpha: 1)

bg.setFill()
NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: s, height: s), xRadius: 40, yRadius: 40).fill()

let ring = NSBezierPath(ovalIn: NSRect(x: s * 0.24, y: s * 0.24, width: s * 0.52, height: s * 0.52))
ring.lineWidth = s * 0.045
ring.setLineDash([s * 0.075, s * 0.055], count: 2, phase: 0)
NSColor(srgbRed: 0x1d / 255.0, green: 0x1d / 255.0, blue: 0x1d / 255.0, alpha: 1).setStroke()
ring.stroke()

let r = s * 0.11
let dot = NSBezierPath(ovalIn: NSRect(x: s / 2 - r, y: s / 2 - r, width: r * 2, height: r * 2))
NSColor(srgbRed: 0xed / 255.0, green: 0x47 / 255.0, blue: 0x3c / 255.0, alpha: 1).setFill()
dot.fill()

NSGraphicsContext.restoreGraphicsState()

guard let data = rep.representation(using: .png, properties: [:]) else {
    fatalError("impossibile codificare il png")
}
try data.write(to: out)
print("Icona generata: \(out.path)")
