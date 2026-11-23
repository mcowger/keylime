import Foundation
import Security
import ExpoModulesCore
import UIKit
import AVFoundation
import UniformTypeIdentifiers

private let networkQueueKey = DispatchSpecificKey<Bool>()
private let networkQueue: DispatchQueue = {
  let queue = DispatchQueue(label: "keylime.network.state")
  queue.setSpecific(key: networkQueueKey, value: true)
  return queue
}()

private func onNetworkQueue(_ work: @escaping () -> Void) {
  if DispatchQueue.getSpecific(key: networkQueueKey) == true {
    work()
  } else {
    networkQueue.async(execute: work)
  }
}

public final class KeylimeNetworkModule: Module {
  private lazy var transport = KeylimeTransport { [weak self] event in
    self?.sendEvent("socketEvent", event)
  }
  private lazy var emitSearch: ([String: Any?]) -> Void = { [weak self] event in
    self?.sendEvent("searchEvent", event)
  }
  private var picker: AttachmentPicker?
  private var pastePicker: AttachmentPastePicker?
  private var speech: AVSpeechSynthesizer?

  public func definition() -> ModuleDefinition {
    Name("KeylimeNetwork")
    Events("socketEvent", "searchEvent")
    Function("newUploadId") { UUID().uuidString.lowercased() }

    AsyncFunction("copyText") { (text: String) in
      UIPasteboard.general.string = text
    }.runOnQueue(.main)

    AsyncFunction("readText") { (text: String) in
      let synthesizer = self.speech ?? AVSpeechSynthesizer()
      self.speech = synthesizer
      synthesizer.stopSpeaking(at: .immediate)
      if !text.isEmpty { synthesizer.speak(AVSpeechUtterance(string: text)) }
    }.runOnQueue(.main)


    AsyncFunction("request") { (origin: String, path: String, method: String, headers: [String: String], body: String?, promise: Promise) in
      self.transport.request(origin: origin, path: path, method: method, headers: headers, body: body, promise: promise)
    }.runOnQueue(networkQueue)

    AsyncFunction("startSearch") { (id: String, origin: String, path: String, promise: Promise) in
      self.transport.startSearch(id: id, origin: origin, path: path, emit: self.emitSearch, promise: promise)
    }.runOnQueue(networkQueue)

    AsyncFunction("requestFileChunk") { (id: String, origin: String, path: String, file: String, offset: Int, length: Int, promise: Promise) in
      self.transport.requestFileChunk(id: id, origin: origin, path: path, file: file, offset: offset, length: length, promise: promise)
    }.runOnQueue(networkQueue)

    AsyncFunction("requestMedia") { (id: String, origin: String, path: String, promise: Promise) in
      self.transport.requestMedia(id: id, origin: origin, path: path, promise: promise)
    }.runOnQueue(networkQueue)

    AsyncFunction("removeMedia") { (id: String) in
      self.transport.removeMedia(id: id)
    }.runOnQueue(networkQueue)

    AsyncFunction("cancelRequest") { (id: String) in
      self.transport.cancelRequest(id: id)
    }.runOnQueue(networkQueue)

    AsyncFunction("pickAttachments") { (source: String, maxPhotoSelection: Int, promise: Promise) in
      guard self.picker == nil, let controller = self.appContext?.utilities?.currentViewController() else {
        promise.reject("ERR_KEYLIME_PICKER", "File picker is unavailable")
        return
      }
      guard source == "files" || source == "photos" else {
        promise.reject("ERR_KEYLIME_PICKER", "Invalid attachment source")
        return
      }
      let picker = AttachmentPicker(promise: promise, maxPhotoSelection: maxPhotoSelection) { [weak self] in self?.picker = nil }
      self.picker = picker
      picker.present(from: controller, photos: source == "photos")
    }.runOnQueue(.main)
    AsyncFunction("pasteAttachmentImage") { (promise: Promise) in
      guard self.pastePicker == nil, let controller = self.appContext?.utilities?.currentViewController() else {
        promise.reject("ERR_KEYLIME_PASTE", "The paste sheet is unavailable.")
        return
      }
      let picker = AttachmentPastePicker(promise: promise) { [weak self] in self?.pastePicker = nil }
      self.pastePicker = picker
      picker.present(from: controller)
    }.runOnQueue(.main)


    AsyncFunction("readAttachmentBase64") { (file: String, promise: Promise) in
      do {
        let url = try attachmentURL(file)
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? Int.max
        guard size <= 5 * 1024 * 1024 else { throw AttachmentError.invalidFile }
        let data = try Data(contentsOf: url)
        promise.resolve(data.base64EncodedString())
      } catch { promise.reject("ERR_KEYLIME_FILE", "Could not read attachment") }
    }

    AsyncFunction("removeAttachmentFile") { (file: String) in
      if let url = try? attachmentURL(file) { try? FileManager.default.removeItem(at: url) }
    }

    AsyncFunction("connectSocket") { (id: String, url: String, promise: Promise) in
      self.transport.connectSocket(id: id, url: url, promise: promise)
    }.runOnQueue(networkQueue)

    AsyncFunction("sendSocket") { (id: String, text: String, promise: Promise) in
      self.transport.sendSocket(id: id, text: text, promise: promise)
    }.runOnQueue(networkQueue)

    AsyncFunction("closeSocket") { (id: String, code: Int, reason: String, promise: Promise) in
      self.transport.closeSocket(id: id, code: code, reason: reason, promise: promise)
    }.runOnQueue(networkQueue)

    OnDestroy {
      DispatchQueue.main.async {
        self.speech?.stopSpeaking(at: .immediate)
        self.speech = nil
      }
      networkQueue.async { self.transport.shutdown() }
    }
  }
}

private struct Origin: Hashable {
  let scheme: String
  let host: String
  let port: Int

  init?(_ url: URL) {
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
          let scheme = components.scheme?.lowercased(),
          scheme == "http" || scheme == "https",
          let host = components.host?.lowercased(), !host.isEmpty,
          components.user == nil, components.password == nil else { return nil }
    let port = components.port ?? (scheme == "https" ? 443 : 80)
    guard (1...65535).contains(port) else { return nil }
    self.scheme = scheme
    self.host = host
    self.port = port
  }

  var keychainAccount: String {
    // Length-prefixed components avoid ambiguities with IPv6 hosts and ports.
    "\(scheme.utf8.count):\(scheme)\(host.utf8.count):\(host)\(port)"
  }
}

private struct StoredCookie {
  let cookie: HTTPCookie
  let expires: Date?
}

private struct PersistedCookie: Codable {
  let value: String
  let path: String
  let secure: Bool
  let expires: Date
}

private enum SessionKeychainError: Error {
  case unavailable
}

private enum SessionKeychain {
  private static let service = "ai.keylime.network.session.v1"

  private static func query(_ origin: Origin) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: origin.keychainAccount,
      kSecAttrSynchronizable as String: false
    ]
  }

  static func load(_ origin: Origin) throws -> [PersistedCookie] {
    var attributes = query(origin)
    attributes[kSecReturnData as String] = true
    attributes[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(attributes as CFDictionary, &result)
    if status == errSecItemNotFound { return [] }
    guard status == errSecSuccess, let data = result as? Data else { throw SessionKeychainError.unavailable }
    guard let cookies = try? JSONDecoder().decode([PersistedCookie].self, from: data) else {
      try remove(origin)
      return []
    }
    return cookies
  }

  static func save(_ cookies: [PersistedCookie], origin: Origin) throws {
    guard !cookies.isEmpty else { try remove(origin); return }
    let data = try JSONEncoder().encode(cookies)
    let base = query(origin)
    let status = SecItemUpdate(base as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if status == errSecItemNotFound {
      var attributes = base
      attributes[kSecValueData as String] = data
      attributes[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
      guard SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess else { throw SessionKeychainError.unavailable }
    } else if status != errSecSuccess {
      throw SessionKeychainError.unavailable
    }
  }

  static func remove(_ origin: Origin) throws {
    let status = SecItemDelete(query(origin) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw SessionKeychainError.unavailable }
  }
}

private final class SocketState {
  let id: String
  let task: URLSessionWebSocketTask
  let origin: Origin
  let httpURL: URL
  let sentCookie: String?
  var open = false
  var closing = false
  var sending = false
  var pending: [(String, Promise)] = []

  init(id: String, task: URLSessionWebSocketTask, origin: Origin, httpURL: URL, sentCookie: String?) {
    self.id = id
    self.task = task
    self.origin = origin
    self.httpURL = httpURL
    self.sentCookie = sentCookie
  }
}

private final class SearchState {
  let id: String
  let origin: Origin
  let emit: ([String: Any?]) -> Void
  var buffer = Data()
  var accepted = false

  init(id: String, origin: Origin, emit: @escaping ([String: Any?]) -> Void) {
    self.id = id
    self.origin = origin
    self.emit = emit
  }
}

private let mediaByteLimit = 32 * 1024 * 1024
private let mediaTotalByteLimit = 256 * 1024 * 1024
private let mediaDirectory = FileManager.default.temporaryDirectory.appendingPathComponent("keylime-media", isDirectory: true)

private func mediaURL(_ id: String) -> URL? {
  guard let uuid = UUID(uuidString: id), uuid.uuidString.lowercased() == id else { return nil }
  return mediaDirectory.appendingPathComponent(id, isDirectory: false)
}

private final class MediaState {
  let id: String
  let origin: Origin
  let url: URL
  let handle: FileHandle
  let promise: Promise
  var count = 0
  var accepted = false
  var error: String?

  init(id: String, origin: Origin, url: URL, handle: FileHandle, promise: Promise) {
    self.id = id
    self.origin = origin
    self.url = url
    self.handle = handle
    self.promise = promise
  }
}

// All state and URLSession delegate callbacks run on networkQueue.
private final class KeylimeTransport: NSObject, URLSessionWebSocketDelegate, URLSessionDataDelegate {
  private let emit: ([String: Any?]) -> Void
  private var cookies: [Origin: [String: StoredCookie]] = [:]
  private var loadedCookieOrigins: Set<Origin> = []
  private var sockets: [String: SocketState] = [:]
  private var socketTasks: [Int: SocketState] = [:]
  private var requests: [String: URLSessionDataTask] = [:]
  private var mediaTasks: [Int: MediaState] = [:]
  private var searchTasks: [Int: SearchState] = [:]
  private var mediaFiles: [String: Int] = [:]
  private var mediaBytes = 0
  private var stopped = false

  private lazy var session: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpShouldSetCookies = false
    configuration.httpCookieStorage = nil
    configuration.urlCredentialStorage = nil
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    queue.underlyingQueue = networkQueue
    return URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
  }()

  init(emit: @escaping ([String: Any?]) -> Void) {
    self.emit = emit
    try? FileManager.default.removeItem(at: mediaDirectory)
  }

  private func fail(_ promise: Promise, _ message: String) {
    promise.reject("ERR_KEYLIME_NETWORK", message)
  }

  func request(origin: String, path: String, method: String, headers: [String: String], body: String?, promise: Promise) {
    request(origin: origin, path: path, method: method, headers: headers, data: body.map { Data($0.utf8) }, id: nil, promise: promise)
  }

  func requestFileChunk(id: String, origin: String, path: String, file: String, offset: Int, length: Int, promise: Promise) {
    guard !id.isEmpty, requests[id] == nil, offset >= 0, length > 0, length <= 1024 * 1024 else {
      fail(promise, "Invalid file chunk")
      return
    }
    do {
      let handle = try FileHandle(forReadingFrom: attachmentURL(file))
      defer { try? handle.close() }
      try handle.seek(toOffset: UInt64(offset))
      guard let data = try handle.read(upToCount: length), data.count == length else { throw AttachmentError.invalidFile }
      request(origin: origin, path: path, method: "PUT", headers: ["Content-Type": "application/octet-stream"], data: data, id: id, promise: promise)
    } catch { fail(promise, "Could not read attachment chunk") }
  }

  func cancelRequest(id: String) {
    requests[id]?.cancel()
  }

  func startSearch(id: String, origin: String, path: String, emit: @escaping ([String: Any?]) -> Void, promise: Promise) {
    guard !id.isEmpty, requests[id] == nil,
          let (url, baseOrigin) = requestURL(origin: origin, path: path),
          let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
          components.path == "/api/sessions/search" else {
      fail(promise, "Invalid search request")
      return
    }
    var request = URLRequest(url: url)
    request.httpShouldHandleCookies = false
    request.httpMethod = "GET"
    do {
      if let cookie = try cookieHeader(for: url, origin: baseOrigin) { request.setValue(cookie, forHTTPHeaderField: "Cookie") }
    } catch {
      fail(promise, "Session Keychain is unavailable")
      return
    }
    let task = session.dataTask(with: request)
    searchTasks[task.taskIdentifier] = SearchState(id: id, origin: baseOrigin, emit: emit)
    requests[id] = task
    task.resume()
    promise.resolve()
  }

  func requestMedia(id: String, origin: String, path: String, promise: Promise) {
    guard !id.isEmpty, requests[id] == nil, let file = mediaURL(id),
          let (url, baseOrigin) = requestURL(origin: origin, path: path),
          let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
          components.path.range(of: "^/api/media/[a-f0-9]{64}$", options: .regularExpression) != nil,
          (components.queryItems ?? []).allSatisfy({ $0.name == "thumb" || $0.name == "hostId" }),
          Set((components.queryItems ?? []).map { $0.name }).count == (components.queryItems ?? []).count else {
      fail(promise, "Invalid media request")
      return
    }
    do {
      var request = URLRequest(url: url)
      request.httpShouldHandleCookies = false
      request.httpMethod = "GET"
      if let cookie = try cookieHeader(for: url, origin: baseOrigin) { request.setValue(cookie, forHTTPHeaderField: "Cookie") }
      try FileManager.default.createDirectory(at: mediaDirectory, withIntermediateDirectories: true)
      guard FileManager.default.createFile(atPath: file.path, contents: nil) else { throw AttachmentError.invalidFile }
      let handle = try FileHandle(forWritingTo: file)
      let task = session.dataTask(with: request)
      mediaTasks[task.taskIdentifier] = MediaState(id: id, origin: baseOrigin, url: file, handle: handle, promise: promise)
      requests[id] = task
      task.resume()
    } catch {
      try? FileManager.default.removeItem(at: file)
      fail(promise, "Could not prepare media")
    }
  }

  func removeMedia(id: String) {
    guard let bytes = mediaFiles.removeValue(forKey: id), let file = mediaURL(id) else { return }
    mediaBytes -= bytes
    try? FileManager.default.removeItem(at: file)
  }

  private func requestURL(origin: String, path: String) -> (URL, Origin)? {
    guard !stopped, let base = URL(string: origin), let baseOrigin = Origin(base),
          let baseParts = URLComponents(url: base, resolvingAgainstBaseURL: false),
          (baseParts.path.isEmpty || baseParts.path == "/"), baseParts.query == nil, baseParts.fragment == nil,
          path.hasPrefix("/"), !path.hasPrefix("//"), !path.contains("\\"),
          let url = URL(string: path, relativeTo: base)?.absoluteURL,
          Origin(url) == baseOrigin, url.fragment == nil else { return nil }
    return (url, baseOrigin)
  }

  private func request(origin: String, path: String, method: String, headers: [String: String], data: Data?, id: String?, promise: Promise) {
    guard let (url, baseOrigin) = requestURL(origin: origin, path: path) else {
      fail(promise, "Invalid origin or request path")
      return
    }
    guard !headers.keys.contains(where: { ["cookie", "host", "proxy-authorization"].contains($0.lowercased()) }) else {
      fail(promise, "A reserved request header was supplied")
      return
    }
    var request = URLRequest(url: url)
    request.httpShouldHandleCookies = false
    request.httpMethod = method
    request.httpBody = data
    for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
    do {
      if let cookie = try cookieHeader(for: url, origin: baseOrigin) { request.setValue(cookie, forHTTPHeaderField: "Cookie") }
    } catch {
      fail(promise, "Session Keychain is unavailable")
      return
    }
    let sentCookie = request.value(forHTTPHeaderField: "Cookie")
    let task = session.dataTask(with: request) { [weak self] data, response, error in
      guard let self = self else { return }
      if let id = id { self.requests[id] = nil }
      guard error == nil, let response = response as? HTTPURLResponse, let responseURL = response.url,
            Origin(responseURL) == baseOrigin else {
        self.fail(promise, "Request failed")
        return
      }
      do {
        try self.processResponse(response, origin: baseOrigin, sentCookie: sentCookie)
      } catch {
        self.fail(promise, "Session Keychain is unavailable")
        return
      }
      var responseHeaders: [String: String] = [:]
      for (key, value) in response.allHeaderFields {
        let name = String(describing: key).lowercased()
        // Cookies stay native, including the HttpOnly session value.
        if name != "set-cookie" && name != "set-cookie2" {
          responseHeaders[name] = String(describing: value)
        }
      }
      promise.resolve([
        "status": response.statusCode,
        "headers": responseHeaders,
        "body": String(decoding: data ?? Data(), as: UTF8.self),
        "url": responseURL.absoluteString
      ] as [String: Any])
    }
    if let id = id { requests[id] = task }
    task.resume()
  }

  private func loadCookies(origin: Origin) throws {
    guard !loadedCookieOrigins.contains(origin) else { return }
    let saved = try SessionKeychain.load(origin)
    var jar: [String: StoredCookie] = [:]
    for item in saved where item.expires > Date() {
      var properties: [HTTPCookiePropertyKey: Any] = [
        .name: "keylime_session", .value: item.value, .domain: origin.host,
        .path: item.path, .expires: item.expires
      ]
      if item.secure { properties[.secure] = "TRUE" }
      guard let cookie = HTTPCookie(properties: properties) else { continue }
      jar[cookie.name + "\n" + cookie.path] = StoredCookie(cookie: cookie, expires: item.expires)
    }
    if jar.count != saved.count { try persistCookies(jar, origin: origin) }
    cookies[origin] = jar
    loadedCookieOrigins.insert(origin)
  }

  private func persistCookies(_ jar: [String: StoredCookie], origin: Origin) throws {
    let saved = jar.values.compactMap { stored -> PersistedCookie? in
      guard let expiry = stored.expires else { return nil }
      return PersistedCookie(value: stored.cookie.value, path: stored.cookie.path, secure: stored.cookie.isSecure, expires: expiry)
    }
    try SessionKeychain.save(saved, origin: origin)
  }

  private func storeCookies(_ response: HTTPURLResponse, origin: Origin) throws {
    guard let url = response.url else { return }
    try loadCookies(origin: origin)
    var fields: [String: String] = [:]
    for (key, value) in response.allHeaderFields {
      fields[String(describing: key)] = String(describing: value)
    }
    var jar = cookies[origin] ?? [:]
    var changed = false
    for cookie in HTTPCookie.cookies(withResponseHeaderFields: fields, for: url) where cookie.name == "keylime_session" {
      let domain = cookie.domain.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
      guard origin.host == domain || origin.host.hasSuffix("." + domain) else { continue }
      let key = cookie.name + "\n" + cookie.path
      var expiry = cookie.expiresDate
      if let age = cookie.properties?[.maximumAge], let seconds = Double(String(describing: age)) {
        expiry = Date().addingTimeInterval(seconds)
      }
      if let expiry = expiry, expiry <= Date() {
        jar[key] = nil
      } else {
        jar[key] = StoredCookie(cookie: cookie, expires: expiry)
      }
      changed = true
    }
    if changed {
      try persistCookies(jar, origin: origin)
      cookies[origin] = jar
    }
  }

  private func cookieHeader(for url: URL, origin: Origin) throws -> String? {
    try loadCookies(origin: origin)
    var jar = cookies[origin] ?? [:]
    let now = Date()
    let valid = jar.filter { $0.value.expires.map { $0 > now } ?? true }
    if valid.count != jar.count {
      try persistCookies(valid, origin: origin)
      jar = valid
      cookies[origin] = jar
    }
    let path = url.path.isEmpty ? "/" : url.path
    let matches = jar.values.filter { stored in
      let cookie = stored.cookie
      let cookiePath = cookie.path.isEmpty ? "/" : cookie.path
      let pathMatches = path == cookiePath || (path.hasPrefix(cookiePath) && (cookiePath.hasSuffix("/") || path.dropFirst(cookiePath.count).first == "/"))
      return pathMatches && (!cookie.isSecure || origin.scheme == "https")
    }.sorted { $0.cookie.path.count > $1.cookie.path.count }
    guard !matches.isEmpty else { return nil }
    return matches.map { "\($0.cookie.name)=\($0.cookie.value)" }.joined(separator: "; ")
  }

  private func rejectCookies(status: Int, url: URL, origin: Origin, sentCookie: String?) throws {
    // Login's 401 rejects the password, not necessarily the existing session.
    guard status == 401, url.path != "/api/web-auth/session", let sentCookie = sentCookie,
          try cookieHeader(for: url, origin: origin) == sentCookie else { return }
    try SessionKeychain.remove(origin)
    cookies[origin] = [:]
  }

  private func processResponse(_ response: HTTPURLResponse, origin: Origin, sentCookie: String?) throws {
    guard let url = response.url else { return }
    // A late rejection must not erase a session established by a newer login.
    if response.statusCode == 401, url.path != "/api/web-auth/session",
       try cookieHeader(for: url, origin: origin) != sentCookie { return }
    try storeCookies(response, origin: origin)
    try rejectCookies(status: response.statusCode, url: url, origin: origin, sentCookie: sentCookie)
  }

  func connectSocket(id: String, url: String, promise: Promise) {
    guard !stopped, !id.isEmpty, sockets[id] == nil,
          let socketURL = URL(string: url), var parts = URLComponents(url: socketURL, resolvingAgainstBaseURL: false),
          let scheme = parts.scheme?.lowercased(), scheme == "ws" || scheme == "wss",
          parts.path == "/api/events/link", parts.fragment == nil,
          parts.user == nil, parts.password == nil else {
      fail(promise, "Invalid socket URL or socket ID")
      return
    }
    parts.scheme = scheme == "wss" ? "https" : "http"
    guard let httpURL = parts.url, let origin = Origin(httpURL) else {
      fail(promise, "Invalid socket origin")
      return
    }
    var request = URLRequest(url: socketURL)
    request.httpShouldHandleCookies = false
    do {
      if let cookie = try cookieHeader(for: httpURL, origin: origin) { request.setValue(cookie, forHTTPHeaderField: "Cookie") }
    } catch {
      fail(promise, "Session Keychain is unavailable")
      return
    }
    let task = session.webSocketTask(with: request)
    let socket = SocketState(id: id, task: task, origin: origin, httpURL: httpURL, sentCookie: request.value(forHTTPHeaderField: "Cookie"))
    sockets[id] = socket
    socketTasks[task.taskIdentifier] = socket
    task.resume()
    promise.resolve()
  }

  func sendSocket(id: String, text: String, promise: Promise) {
    guard let socket = sockets[id], !socket.closing else {
      fail(promise, "Socket is not available")
      return
    }
    socket.pending.append((text, promise))
    sendNext(socket)
  }

  private func sendNext(_ socket: SocketState) {
    guard socket.open, !socket.closing, !socket.sending, !socket.pending.isEmpty else { return }
    socket.sending = true
    let (text, promise) = socket.pending.removeFirst()
    socket.task.send(.string(text)) { [weak self, weak socket] error in
      onNetworkQueue {
        guard let self = self, let socket = socket else {
          promise.reject("ERR_KEYLIME_NETWORK", "Socket closed")
          return
        }
        socket.sending = false
        if error != nil || self.sockets[socket.id] !== socket {
          self.fail(promise, "Socket send failed")
        } else {
          promise.resolve()
          self.sendNext(socket)
        }
      }
    }
  }

  func closeSocket(id: String, code: Int, reason: String, promise: Promise) {
    guard let socket = sockets[id] else { promise.resolve(); return }
    guard (code == 1000 || (3000...4999).contains(code)),
          reason.utf8.count <= 123, let closeCode = URLSessionWebSocketTask.CloseCode(rawValue: code) else {
      fail(promise, "Invalid socket close code or reason")
      return
    }
    if !socket.closing {
      socket.closing = true
      rejectPending(socket)
      socket.task.cancel(with: closeCode, reason: Data(reason.utf8))
    }
    promise.resolve()
  }

  private func receive(_ socket: SocketState) {
    socket.task.receive { [weak self, weak socket] result in
      onNetworkQueue {
        guard let self = self, let socket = socket, self.sockets[socket.id] === socket, !socket.closing else { return }
        switch result {
        case .success(.string(let text)):
          self.emit(["id": socket.id, "type": "message", "data": text])
          self.receive(socket)
        case .success(.data):
          self.emit(["id": socket.id, "type": "error"])
          socket.task.cancel(with: .unsupportedData, reason: nil)
        case .failure:
          // didCompleteWithError or didClose supplies the single terminal event.
          break
        @unknown default:
          socket.task.cancel(with: .unsupportedData, reason: nil)
        }
      }
    }
  }

  private func rejectPending(_ socket: SocketState) {
    for (_, promise) in socket.pending { fail(promise, "Socket closed") }
    socket.pending.removeAll()
  }

  private func finish(_ socket: SocketState, code: Int, reason: String) {
    guard sockets[socket.id] === socket else { return }
    sockets[socket.id] = nil
    socketTasks[socket.task.taskIdentifier] = nil
    rejectPending(socket)
    emit(["id": socket.id, "type": "close", "code": code, "reason": reason])
  }

  func shutdown() {
    guard !stopped else { return }
    stopped = true
    for socket in Array(sockets.values) {
      socket.task.cancel(with: .goingAway, reason: nil)
      finish(socket, code: 1001, reason: "")
    }
    for media in mediaTasks.values {
      try? media.handle.close()
      try? FileManager.default.removeItem(at: media.url)
      fail(media.promise, "Request cancelled")
    }
    mediaTasks.removeAll()
    searchTasks.removeAll()
    mediaFiles.removeAll()
    mediaBytes = 0
    try? FileManager.default.removeItem(at: mediaDirectory)
    requests.removeAll()
    cookies.removeAll()
    session.invalidateAndCancel()
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    if let search = searchTasks[dataTask.taskIdentifier] {
      guard let http = response as? HTTPURLResponse, let url = http.url, Origin(url) == search.origin else {
        completionHandler(.cancel)
        return
      }
      do {
        try processResponse(http, origin: search.origin, sentCookie: dataTask.originalRequest?.value(forHTTPHeaderField: "Cookie"))
      } catch {
        completionHandler(.cancel)
        return
      }
      search.accepted = true
      search.emit(["id": search.id, "type": "response", "status": http.statusCode])
      completionHandler(.allow)
      return
    }
    guard let media = mediaTasks[dataTask.taskIdentifier] else { completionHandler(.allow); return }
    guard let http = response as? HTTPURLResponse, let url = http.url, Origin(url) == media.origin else {
      media.error = "Media request was refused or the image is too large"
      completionHandler(.cancel)
      return
    }
    do {
      try processResponse(http, origin: media.origin, sentCookie: dataTask.originalRequest?.value(forHTTPHeaderField: "Cookie"))
    } catch {
      media.error = "Session Keychain is unavailable"
      completionHandler(.cancel)
      return
    }
    guard http.statusCode == 200, http.mimeType?.lowercased().hasPrefix("image/") == true,
          response.expectedContentLength <= Int64(mediaByteLimit) else {
      media.error = "Media request was refused or the image is too large"
      completionHandler(.cancel)
      return
    }
    media.accepted = true
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    if let search = searchTasks[dataTask.taskIdentifier] {
      guard search.accepted else { return }
      search.buffer.append(data)
      if let newline = search.buffer.lastIndex(of: 10) {
        let end = search.buffer.index(after: newline)
        let complete = search.buffer.prefix(upTo: end)
        guard let text = String(data: complete, encoding: .utf8) else {
          dataTask.cancel()
          return
        }
        search.buffer.removeSubrange(..<end)
        search.emit(["id": search.id, "type": "data", "data": text])
      }
      return
    }
    guard let media = mediaTasks[dataTask.taskIdentifier], media.accepted else { return }
    guard data.count <= mediaByteLimit - media.count, data.count <= mediaTotalByteLimit - mediaBytes else {
      media.error = "Image is too large"
      dataTask.cancel()
      return
    }
    do {
      try media.handle.write(contentsOf: data)
      media.count += data.count
      mediaBytes += data.count
    } catch {
      media.error = "Could not save image"
      dataTask.cancel()
    }
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    guard let socket = socketTasks[webSocketTask.taskIdentifier], !socket.closing else { return }
    socket.open = true
    emit(["id": socket.id, "type": "open"])
    receive(socket)
    sendNext(socket)
  }
  private func handleSocketRejection(_ socket: SocketState) {
    guard let response = socket.task.response as? HTTPURLResponse else { return }
    do {
      try rejectCookies(status: response.statusCode, url: socket.httpURL, origin: socket.origin, sentCookie: socket.sentCookie)
    } catch {
      emit(["id": socket.id, "type": "error"])
    }
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    guard let socket = socketTasks[webSocketTask.taskIdentifier] else { return }
    handleSocketRejection(socket)
    finish(socket, code: closeCode.rawValue, reason: reason.flatMap { String(data: $0, encoding: .utf8) } ?? "")
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if let search = searchTasks.removeValue(forKey: task.taskIdentifier) {
      requests[search.id] = nil
      if error == nil, search.accepted, let tail = String(data: search.buffer, encoding: .utf8) {
        if !tail.isEmpty { search.emit(["id": search.id, "type": "data", "data": tail]) }
        search.emit(["id": search.id, "type": "done"])
      } else {
        search.emit(["id": search.id, "type": "error"])
      }
      return
    }
    if let media = mediaTasks.removeValue(forKey: task.taskIdentifier) {
      requests[media.id] = nil
      try? media.handle.close()
      if error != nil || media.error != nil || !media.accepted || media.count == 0 {
        try? FileManager.default.removeItem(at: media.url)
        mediaBytes -= media.count
        fail(media.promise, media.error ?? "Media request failed")
      } else {
        mediaFiles[media.id] = media.count
        media.promise.resolve(["id": media.id, "uri": media.url.absoluteString])
      }
      return
    }
    guard let socket = socketTasks[task.taskIdentifier] else { return }
    handleSocketRejection(socket)
    if error != nil { emit(["id": socket.id, "type": "error"]) }
    finish(socket, code: 1006, reason: "")
  }
}
