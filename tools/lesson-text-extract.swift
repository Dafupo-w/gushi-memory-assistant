import AppKit
import Foundation
import PDFKit
import Vision

func cgImage(from image: NSImage) -> CGImage? {
  var rect = CGRect(origin: .zero, size: image.size)
  return image.cgImage(forProposedRect: &rect, context: nil, hints: nil)
}

func recognize(_ image: CGImage) throws -> String {
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  request.recognitionLanguages = ["zh-Hans", "zh-Hant"]
  let handler = VNImageRequestHandler(cgImage: image, options: [:])
  try handler.perform([request])
  let observations = (request.results ?? []).sorted {
    let verticalDifference = abs($0.boundingBox.midY - $1.boundingBox.midY)
    if verticalDifference > 0.025 { return $0.boundingBox.midY > $1.boundingBox.midY }
    return $0.boundingBox.minX < $1.boundingBox.minX
  }
  return observations.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
}

func extractImage(at url: URL) throws -> String {
  guard let image = NSImage(contentsOf: url), let cgImage = cgImage(from: image) else {
    throw NSError(domain: "LessonTextExtract", code: 1, userInfo: [NSLocalizedDescriptionKey: "无法读取图片文件"])
  }
  return try recognize(cgImage)
}

func extractPdf(at url: URL) throws -> String {
  guard let document = PDFDocument(url: url) else {
    throw NSError(domain: "LessonTextExtract", code: 2, userInfo: [NSLocalizedDescriptionKey: "无法读取 PDF 文件"])
  }
  var pages: [String] = []
  for index in 0..<document.pageCount {
    guard let page = document.page(at: index) else { continue }
    if let text = page.string?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
      pages.append(text)
      continue
    }
    let image = page.thumbnail(of: CGSize(width: 2400, height: 3200), for: .mediaBox)
    if let cgImage = cgImage(from: image) {
      let text = try recognize(cgImage)
      if !text.isEmpty { pages.append(text) }
    }
  }
  return pages.joined(separator: "\n\n")
}

let arguments = CommandLine.arguments
if arguments.count != 2 {
  FileHandle.standardError.write(Data("Usage: lesson-text-extract <file>\n".utf8))
  exit(64)
}

let url = URL(fileURLWithPath: arguments[1])
do {
  let extensionName = url.pathExtension.lowercased()
  let text: String
  if extensionName == "pdf" {
    text = try extractPdf(at: url)
  } else {
    text = try extractImage(at: url)
  }
  print(text)
} catch {
  FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
  exit(1)
}
