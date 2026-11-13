import SwiftUI
import UIKit

/// Signed links to files in the private bucket, remembered so a list of avatars is one request and a scroll back up is none.
final class SignedURLCache {
    static let shared = SignedURLCache()
    private var urls: [String: (url: URL, expires: Date)] = [:]
    private let lock = NSLock()

    func cached(_ path: String) -> URL? {
        lock.lock(); defer { lock.unlock() }
        guard let entry = urls[path], entry.expires.timeIntervalSinceNow > 300 else { return nil }
        return entry.url
    }

    /// Signs everything in `paths` that does not have a good link yet, in one call.
    func prefetch(_ paths: [String]) async {
        let missing = Array(Set(paths)).filter { cached($0) == nil }
        guard !missing.isEmpty, let signed = try? await SupabaseAPI.shared.signedURLs(missing, expiresIn: 3600) else { return }
        lock.lock()
        for (path, url) in signed { urls[path] = (url, Date().addingTimeInterval(3600)) }
        lock.unlock()
    }

    func url(for path: String) async -> URL? {
        if let url = cached(path) { return url }
        await prefetch([path])
        return cached(path)
    }

    func clear() { lock.lock(); urls.removeAll(); lock.unlock() }
}

/// Decoded pictures by file path (not by link, since the link changes every hour while the file does not).
final class PictureCache {
    static let shared = PictureCache()
    private let cache: NSCache<NSString, UIImage> = {
        let c = NSCache<NSString, UIImage>()
        c.totalCostLimit = 60 * 1024 * 1024
        return c
    }()

    func image(for path: String) -> UIImage? { cache.object(forKey: path as NSString) }

    func load(_ path: String) async -> UIImage? {
        if let hit = image(for: path) { return hit }
        guard let url = await SignedURLCache.shared.url(for: path),
              let (data, response) = try? await URLSession.shared.data(from: url),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let image = UIImage(data: data) else { return nil }
        cache.setObject(image, forKey: path as NSString, cost: Int(image.size.width * image.size.height * image.scale * image.scale * 4))
        return image
    }

    func clear() { cache.removeAllObjects() }
}

/// A picture from the private bucket. Shows `placeholder` until it has loaded, and again if it cannot.
struct StoredImage<Placeholder: View>: View {
    let path: String?
    var contentMode: ContentMode = .fill
    @ViewBuilder var placeholder: () -> Placeholder
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image = image ?? path.flatMap({ PictureCache.shared.image(for: $0) }) {
                Image(uiImage: image).resizable().aspectRatio(contentMode: contentMode)
            } else {
                placeholder()
            }
        }
        .task(id: path) {
            guard let path else { image = nil; return }
            image = await PictureCache.shared.load(path)
        }
    }
}
