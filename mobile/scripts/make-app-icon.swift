#!/usr/bin/env swift
//
// Generate the app icon PNG.
//
// The icon is a PLACEHOLDER. The product is being renamed and Abi has not
// chosen a final mark, so this draws something neutral that survives being
// replaced: a geometric mark on a graded background, with no wordmark and no
// letters in it. Text is unreadable at icon sizes anyway, and a wordmark baked
// into an icon is the one part of it that cannot be recoloured or reused when
// the name finally changes.
//
// Generated rather than drawn by hand in an image editor for the same reason
// the Xcode project is generated: a bitmap committed with no way to reproduce
// it is a file nobody can adjust. Replacing the mark means editing the marks
// below and re-running this, which is a readable diff, rather than opening an
// editor and hoping the result matches what was there before.
//
// Output is a 1024x1024 PNG with NO alpha channel, on purpose. App Store
// Connect rejects an app icon that carries alpha, and this is the file that
// ends up inside the icon set, so the guarantee belongs at the point of
// writing rather than in a manual step afterwards. The context is created as
// `noneSkipLast` for exactly that reason.
//
// Usage:
//
//     swift mobile/scripts/make-app-icon.swift [output.png]
//
// The output path defaults to mobile/Claw/Assets.xcassets/AppIcon.appiconset,
// which is where the asset catalog reads the single 1024x1024 entry from.

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// --------------------------------------------------------------------------
// The design, in one place
// --------------------------------------------------------------------------

/// The canvas. App Store requires exactly 1024x1024 for the single size icon.
let side = 1024

/// The mark is centred, and the pair of radii are what make it read at 40
/// points as well as at 1024 pixels: a solid disc with a ring around it. The
/// gap between them is deliberate, because a ring that nearly touches the disc
/// turns into a smudge when iOS downsamples the icon for the home screen.
let discRadius: CGFloat = 104
let ringRadius: CGFloat = 264
let ringStroke: CGFloat = 70

/// The background, a vertical grade rather than a flat colour. Dark slate, so
/// the warm mark carries the whole contrast and the icon does not depend on
/// being seen against a particular wallpaper.
let backgroundTop = (r: 0.157, g: 0.184, b: 0.235)
let backgroundBottom = (r: 0.075, g: 0.090, b: 0.118)

/// The mark's grade, top left to bottom right, and the same family as the
/// app's AccentColor set so the icon and the UI agree about what the accent is.
let markStart = (r: 1.000, g: 0.361, b: 0.302)
let markEnd = (r: 0.776, g: 0.157, b: 0.157)

// --------------------------------------------------------------------------
// Drawing
// --------------------------------------------------------------------------

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("error: \(message)\n".utf8))
    exit(1)
}

guard let space = CGColorSpace(name: CGColorSpace.sRGB) else {
    fail("could not create an sRGB colour space")
}

func colour(_ r: Double, _ g: Double, _ b: Double, _ a: Double = 1) -> CGColor {
    guard let colour = CGColor(colorSpace: space, components: [CGFloat(r), CGFloat(g), CGFloat(b), CGFloat(a)]) else {
        fail("could not create a colour in the sRGB space")
    }
    return colour
}

// `noneSkipLast` is the no-alpha part: the context stores 32 bits per pixel
// with the fourth byte skipped, so the PNG ImageIO writes carries three
// channels and no alpha channel at all.
guard let context = CGContext(
    data: nil,
    width: side,
    height: side,
    bitsPerComponent: 8,
    bytesPerRow: 0,
    space: space,
    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
) else {
    fail("could not create a \(side)x\(side) bitmap context")
}

// CoreGraphics puts the origin at the bottom left, so y increasing is up.
let full = CGRect(x: 0, y: 0, width: side, height: side)

// The background, top to bottom.
guard let background = CGGradient(
    colorsSpace: space,
    colors: [colour(backgroundTop.r, backgroundTop.g, backgroundTop.b),
             colour(backgroundBottom.r, backgroundBottom.g, backgroundBottom.b)] as CFArray,
    locations: [0, 1]
) else {
    fail("could not build the background gradient")
}
context.drawLinearGradient(
    background,
    start: CGPoint(x: 0, y: CGFloat(side)),
    end: CGPoint(x: 0, y: 0),
    options: []
)

// A soft highlight behind the mark, lifted a little above centre. It is what
// stops a graded background reading as a flat one at large sizes, and it is
// faint enough to disappear entirely at small ones.
guard let highlight = CGGradient(
    colorsSpace: space,
    colors: [colour(1, 1, 1, 0.075), colour(1, 1, 1, 0)] as CFArray,
    locations: [0, 1]
) else {
    fail("could not build the highlight gradient")
}
context.drawRadialGradient(
    highlight,
    startCenter: CGPoint(x: CGFloat(side) / 2, y: CGFloat(side) / 2 + 90),
    startRadius: 0,
    endCenter: CGPoint(x: CGFloat(side) / 2, y: CGFloat(side) / 2 + 90),
    endRadius: CGFloat(side) * 0.52,
    options: []
)

let centre = CGPoint(x: CGFloat(side) / 2, y: CGFloat(side) / 2)

// The mark's gradient is diagonal and spans the whole mark, so the ring and
// the disc are lit from the same direction and read as one object.
func drawMark(in path: CGPath, lineWidth: CGFloat) {
    context.saveGState()
    context.addPath(path)
    if lineWidth > 0 {
        context.setLineWidth(lineWidth)
        // Stroke the path into a fillable outline, then clip to it: a gradient
        // stroke cannot be asked for directly, and clipping is what applies the
        // same gradient to a stroke and to a fill.
        context.replacePathWithStrokedPath()
    }
    context.clip()
    guard let mark = CGGradient(
        colorsSpace: space,
        colors: [colour(markStart.r, markStart.g, markStart.b),
                 colour(markEnd.r, markEnd.g, markEnd.b)] as CFArray,
        locations: [0, 1]
    ) else {
        fail("could not build the mark gradient")
    }
    context.drawLinearGradient(
        mark,
        start: CGPoint(x: centre.x - ringRadius, y: centre.y + ringRadius),
        end: CGPoint(x: centre.x + ringRadius, y: centre.y - ringRadius),
        options: []
    )
    context.restoreGState()
}

let ringRect = CGRect(
    x: centre.x - ringRadius,
    y: centre.y - ringRadius,
    width: ringRadius * 2,
    height: ringRadius * 2
)
drawMark(in: CGPath(ellipseIn: ringRect, transform: nil), lineWidth: ringStroke)

let discRect = CGRect(
    x: centre.x - discRadius,
    y: centre.y - discRadius,
    width: discRadius * 2,
    height: discRadius * 2
)
drawMark(in: CGPath(ellipseIn: discRect, transform: nil), lineWidth: 0)

// --------------------------------------------------------------------------
// Writing, then reading the result back
// --------------------------------------------------------------------------

let arguments = Array(CommandLine.arguments.dropFirst())
let defaultOutput = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()   // scripts/
    .deletingLastPathComponent()   // mobile/
    .appendingPathComponent("Claw/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png")
let output = arguments.first.map { URL(fileURLWithPath: $0) } ?? defaultOutput

guard let image = context.makeImage() else {
    fail("the context produced no image")
}

guard let destination = CGImageDestinationCreateWithURL(
    output as CFURL,
    UTType.png.identifier as CFString,
    1,
    nil
) else {
    fail("could not open \(output.path) for writing")
}
CGImageDestinationAddImage(destination, image, nil)
guard CGImageDestinationFinalize(destination) else {
    fail("could not write \(output.path)")
}

// Read the file back rather than trusting that writing it worked. What App
// Store Connect refuses is a 1024x1024 icon carrying an alpha channel, and both
// of those are properties of the file on disk rather than of the drawing above.
guard let source = CGImageSourceCreateWithURL(output as CFURL, nil),
      let written = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    fail("wrote \(output.path) but could not read it back")
}

let alpha = written.alphaInfo
guard written.width == side, written.height == side else {
    fail("wrote \(written.width)x\(written.height), expected \(side)x\(side)")
}
guard alpha == .none || alpha == .noneSkipLast || alpha == .noneSkipFirst else {
    fail("the written icon carries an alpha channel (\(alpha)); App Store Connect rejects one")
}

print("wrote \(output.path)")
print("  \(written.width)x\(written.height), alphaInfo \(alpha)")
