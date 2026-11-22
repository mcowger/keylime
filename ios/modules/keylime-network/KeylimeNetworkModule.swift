import Foundation
import ExpoModulesCore

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

  public func definition() -> ModuleDefinition {
    Name("KeylimeNetwork")
    Events("socketEvent")

    AsyncFunction("request") { (origin: String, path: String, method: String, headers: [String: String], body: String?, promise: Promise) in
      self.transport.request(origin: origin, path: path, method: method, headers: headers, body: body, promise: promise)
    }.runOnQueue(networkQueue)

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
}

private struct StoredCookie {
  let cookie: HTTPCookie
  let expires: Date?
}

private final class SocketState {
  let id: String
  let task: URLSessionWebSocketTask
  var open = false
  var closing = false
  var sending = false
  var pending: [(String, Promise)] = []

  init(id: String, task: URLSessionWebSocketTask) {
    self.id = id
    self.task = task
  }
}

// All state and URLSession delegate callbacks run on networkQueue.
private final class KeylimeTransport: NSObject, URLSessionWebSocketDelegate {
  private let emit: ([String: Any?]) -> Void
  private var cookies: [Origin: [String: StoredCookie]] = [:]
  private var sockets: [String: SocketState] = [:]
  private var socketTasks: [Int: SocketState] = [:]
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
  }

  private func fail(_ promise: Promise, _ message: String) {
    promise.reject("ERR_KEYLIME_NETWORK", message)
  }

  func request(origin: String, path: String, method: String, headers: [String: String], body: String?, promise: Promise) {
    guard !stopped, let base = URL(string: origin), let baseOrigin = Origin(base),
          let baseParts = URLComponents(url: base, resolvingAgainstBaseURL: false),
          (baseParts.path.isEmpty || baseParts.path == "/"), baseParts.query == nil, baseParts.fragment == nil,
          path.hasPrefix("/"), !path.hasPrefix("//"), !path.contains("\\"),
          let url = URL(string: path, relativeTo: base)?.absoluteURL,
          Origin(url) == baseOrigin, url.fragment == nil else {
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
    request.httpBody = body.map { Data($0.utf8) }
    for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
    if let cookie = cookieHeader(for: url, origin: baseOrigin) {
      request.setValue(cookie, forHTTPHeaderField: "Cookie")
    }
    session.dataTask(with: request) { [weak self] data, response, error in
      guard let self = self else { return }
      guard error == nil, let response = response as? HTTPURLResponse, let responseURL = response.url,
            Origin(responseURL) == baseOrigin else {
        self.fail(promise, "Request failed")
        return
      }
      self.storeCookies(response, origin: baseOrigin)
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
    }.resume()
  }

  private func storeCookies(_ response: HTTPURLResponse, origin: Origin) {
    guard let url = response.url else { return }
    var fields: [String: String] = [:]
    for (key, value) in response.allHeaderFields {
      fields[String(describing: key)] = String(describing: value)
    }
    for cookie in HTTPCookie.cookies(withResponseHeaderFields: fields, for: url) where cookie.name == "keylime_session" {
      let domain = cookie.domain.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
      guard origin.host == domain || origin.host.hasSuffix("." + domain) else { continue }
      let key = cookie.name + "\n" + cookie.path
      var expiry = cookie.expiresDate
      if let age = cookie.properties?[.maximumAge], let seconds = Double(String(describing: age)) {
        expiry = Date().addingTimeInterval(seconds)
      }
      if let expiry = expiry, expiry <= Date() {
        cookies[origin]?[key] = nil
      } else {
        cookies[origin, default: [:]][key] = StoredCookie(cookie: cookie, expires: expiry)
      }
    }
  }

  private func cookieHeader(for url: URL, origin: Origin) -> String? {
    guard var jar = cookies[origin] else { return nil }
    let now = Date()
    jar = jar.filter { $0.value.expires.map { $0 > now } ?? true }
    cookies[origin] = jar
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
    if let cookie = cookieHeader(for: httpURL, origin: origin) {
      request.setValue(cookie, forHTTPHeaderField: "Cookie")
    }
    let task = session.webSocketTask(with: request)
    let socket = SocketState(id: id, task: task)
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
    cookies.removeAll()
    session.invalidateAndCancel()
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    guard let socket = socketTasks[webSocketTask.taskIdentifier], !socket.closing else { return }
    socket.open = true
    emit(["id": socket.id, "type": "open"])
    receive(socket)
    sendNext(socket)
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    guard let socket = socketTasks[webSocketTask.taskIdentifier] else { return }
    finish(socket, code: closeCode.rawValue, reason: reason.flatMap { String(data: $0, encoding: .utf8) } ?? "")
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let socket = socketTasks[task.taskIdentifier] else { return }
    if error != nil { emit(["id": socket.id, "type": "error"]) }
    finish(socket, code: 1006, reason: "")
  }
}
