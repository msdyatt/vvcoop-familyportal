import ImageIO
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// A photo or file chosen for the next message, not yet sent. The same limits as the web (lib/messages.ts): up to 10 per message, 10 MB
/// for a document, photos shrunk before they go.
struct PendingAttachment: Identifiable {
    enum Kind { case image, file }
    let id = UUID()
    let kind: Kind
    /// Shown name; for a photo "photo.jpg".
    let name: String
    let mime: String
    /// What will be uploaded: the shrunk JPEG, or the document as it is.
    let data: Data
    /// A small picture for the chip (photos only).
    let preview: UIImage?

    var size: Int { data.count }
}

enum AttachmentRules {
    static let maxCount = 10
    static let maxFileBytes = 10 * 1024 * 1024

    /// The documents Messages accepts, by extension. The database checks the same list again.
    static let documentTypes: [String: String] = [
        "pdf": "application/pdf",
        "doc": "application/msword",
        "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "ppt": "application/vnd.ms-powerpoint",
        "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "xls": "application/vnd.ms-excel",
        "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "csv": "text/csv",
    ]

    /// What the document picker offers: photos and the documents above.
    static var pickerTypes: [UTType] { [.image] + documentTypes.keys.compactMap { UTType(filenameExtension: $0) } }

    enum Problem: LocalizedError {
        case notAllowed(String), tooBig(String), unreadable(String)
        var errorDescription: String? {
            switch self {
            case .notAllowed(let name): return "\(name) is not a photo, PDF, Word, PowerPoint, Excel or CSV file."
            case .tooBig(let name): return "\(name) is over 10 MB."
            case .unreadable(let name): return "\(name) could not be read."
            }
        }
    }

    /// Prepares a picked photo: longest side at most 1600 pt, JPEG at 0.85, and re-drawn, which also drops everything else in the
    /// original file, including the GPS position and camera details phones embed. Photos of children are shared here, so that is deliberate.
    static func photo(from data: Data, name: String = "photo.jpg") throws -> PendingAttachment {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { throw Problem.unreadable(name) }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true, // applies the phone's rotation before the metadata is dropped
            kCGImageSourceThumbnailMaxPixelSize: 1600,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { throw Problem.unreadable(name) }
        let image = UIImage(cgImage: cg)
        guard let jpeg = image.jpegData(compressionQuality: 0.85) else { throw Problem.unreadable(name) }
        let thumbnail = image.preparingThumbnail(of: CGSize(width: 160, height: 160)) ?? image
        return PendingAttachment(kind: .image, name: "photo.jpg", mime: "image/jpeg", data: jpeg, preview: thumbnail)
    }

    /// A chosen file: a photo is shrunk like any other; a document is checked for type and size and sent as it is.
    static func file(at url: URL) throws -> PendingAttachment {
        let name = url.lastPathComponent
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let ext = url.pathExtension.lowercased()
        if let type = UTType(filenameExtension: ext), type.conforms(to: .image) {
            guard let data = try? Data(contentsOf: url) else { throw Problem.unreadable(name) }
            return try photo(from: data)
        }
        guard let mime = documentTypes[ext] else { throw Problem.notAllowed(name) }
        let values = try? url.resourceValues(forKeys: [.fileSizeKey])
        if let size = values?.fileSize, size > maxFileBytes { throw Problem.tooBig(name) }
        guard let data = try? Data(contentsOf: url) else { throw Problem.unreadable(name) }
        if data.count > maxFileBytes { throw Problem.tooBig(name) }
        return PendingAttachment(kind: .file, name: String(name.prefix(160)), mime: mime, data: data, preview: nil)
    }

    /// The storage name the web uses: a random id then the file name with anything odd replaced.
    static func storagePath(conversationId: String, name: String) -> String {
        let safe = name.replacingOccurrences(of: "[^a-zA-Z0-9._-]", with: "_", options: .regularExpression)
        return "messages/\(conversationId)/\(UUID().uuidString.lowercased())-\(safe)"
    }
}

/// The camera, for Take Photo. (Not available in the Simulator.)
struct CameraPicker: UIViewControllerRepresentable {
    var onPicked: (Data) -> Void
    var onCancel: () -> Void

    static var isAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage, let data = image.jpegData(compressionQuality: 0.95) { parent.onPicked(data) } else { parent.onCancel() }
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.onCancel() }
    }
}

/// Chips for what is ready to send: a thumbnail for a photo, name and size for a document, each with a way to take it off.
struct PendingStrip: View {
    let items: [PendingAttachment]
    var onRemove: (PendingAttachment) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(items) { item in
                    ZStack(alignment: .topTrailing) {
                        Group {
                            if let preview = item.preview {
                                Image(uiImage: preview).resizable().scaledToFill().frame(width: 64, height: 64).clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                            } else {
                                HStack(spacing: 8) {
                                    Image(systemName: "doc.text").font(.title3)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(item.name).font(.caption.weight(.semibold)).lineLimit(1)
                                        Text(formatBytes(item.size)).font(.caption2).foregroundColor(MT.muted)
                                    }
                                }
                                .foregroundColor(MT.text).frame(maxWidth: 170, alignment: .leading)
                                .padding(.horizontal, 10).frame(height: 64).background(MT.sunken, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                            }
                        }
                        Button { onRemove(item) } label: {
                            Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundColor(.white).frame(width: 20, height: 20).background(Circle().fill(MT.text.opacity(0.8)))
                        }
                        .offset(x: 6, y: -6)
                        .accessibilityLabel("Remove \(item.name)")
                    }
                    .padding(.top, 6).padding(.trailing, 6)
                }
            }
            .padding(.horizontal, 12).padding(.top, 4)
        }
        .accessibilityLabel("Ready to send")
    }
}
