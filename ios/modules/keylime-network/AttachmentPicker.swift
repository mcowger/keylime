import ExpoModulesCore
import Foundation
import UIKit
import ImageIO
import PhotosUI
import UniformTypeIdentifiers

private let attachmentDirectory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
  .appendingPathComponent("keylime-attachments", isDirectory: true)

enum AttachmentError: Error { case invalidFile }

// The bridge accepts only opaque picker-issued UUIDs, never arbitrary filesystem paths.
func attachmentURL(_ id: String) throws -> URL {
  guard let uuid = UUID(uuidString: id), uuid.uuidString.lowercased() == id else { throw AttachmentError.invalidFile }
  return attachmentDirectory.appendingPathComponent(id, isDirectory: false)
}

// UIPasteControl is an explicit user gesture, so iOS can grant the paste without
// a separate cross-app paste permission prompt. Providers may expose files,
// data, or only a UIImage; do not rely on UIPasteboard.image.
final class AttachmentPastePicker: UIViewController, UIAdaptivePresentationControllerDelegate {
  private let promise: Promise
  private let finish: () -> Void
  private var completed = false
  private let cancelButton = UIButton(type: .system)
  private let status = UILabel()
  private let pasteControl = UIPasteControl(configuration: UIPasteControl.Configuration())

  init(promise: Promise, finish: @escaping () -> Void) {
    self.promise = promise
    self.finish = finish
    super.init(nibName: nil, bundle: nil)
    pasteConfiguration = UIPasteConfiguration(acceptableTypeIdentifiers: [UTType.image.identifier])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    status.text = "Tap Paste to attach an image. If Paste is unavailable, copy an image first."
    status.numberOfLines = 0
    status.textAlignment = .center
    status.font = .preferredFont(forTextStyle: .body)
    pasteControl.target = self
    cancelButton.setTitle("Cancel", for: .normal)
    cancelButton.addTarget(self, action: #selector(cancel), for: .touchUpInside)
    let stack = UIStackView(arrangedSubviews: [status, pasteControl, cancelButton])
    stack.axis = .vertical
    stack.alignment = .center
    stack.spacing = 24
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
      stack.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor),
    ])
  }

  func present(from controller: UIViewController) {
    modalPresentationStyle = .pageSheet
    if let sheet = sheetPresentationController { sheet.detents = [.medium(), .large()] }
    // React Native calls its action-sheet callback from the action handler,
    // before UIKit has necessarily finished dismissing the sheet.
    let alert = (controller as? UIAlertController) ?? (controller.presentedViewController as? UIAlertController)
    if let alert = alert, let presenter = alert.presentingViewController {
      if let transition = alert.transitionCoordinator {
        transition.animate(alongsideTransition: nil) { _ in self.show(from: presenter) }
      } else {
        alert.dismiss(animated: true) { self.show(from: presenter) }
      }
    } else {
      show(from: controller)
    }
  }

  private func show(from controller: UIViewController) {
    guard controller.viewIfLoaded?.window != nil else {
      complete(error: "The paste sheet is unavailable.")
      return
    }
    controller.present(self, animated: true) { self.presentationController?.delegate = self }
  }

  @objc private func cancel() { complete() }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { complete() }

  override func paste(itemProviders: [NSItemProvider]) {
    guard !completed else { return }
    isModalInPresentation = true
    cancelButton.isEnabled = false
    pasteControl.isUserInteractionEnabled = false
    status.text = "Reading image…"
    let providers = itemProviders.filter { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) || $0.canLoadObject(ofClass: UIImage.self) }
    guard !providers.isEmpty else {
      complete(error: "The clipboard did not provide an image.")
      return
    }
    load(providers: providers, index: 0)
  }

  private func load(providers: [NSItemProvider], index: Int) {
    guard index < providers.count else {
      complete(error: "Could not read or save the pasted image. The clipboard provider may have denied access or failed.")
      return
    }
    let provider = providers[index]
    let types = provider.registeredTypeIdentifiers.filter { identifier in
      guard let type = UTType(identifier) else { return false }
      return type.conforms(to: .image)
    }
    load(provider: provider, types: types, index: 0) { result in
      if let result = result { self.complete(result: result) }
      else { self.load(providers: providers, index: index + 1) }
    }
  }

  private func load(provider: NSItemProvider, types: [String], index: Int, done: @escaping ([String: Any]?) -> Void) {
    guard index < types.count else {
      guard provider.canLoadObject(ofClass: UIImage.self) else { done(nil); return }
      provider.loadObject(ofClass: UIImage.self) { image, _ in
        let result = (image as? UIImage).flatMap { $0.pngData() }.flatMap { try? Self.save(data: $0, type: .png) }
        DispatchQueue.main.async { done(result) }
      }
      return
    }
    let identifier = types[index]
    provider.loadFileRepresentation(forTypeIdentifier: identifier) { url, _ in
      // The provider's temporary URL is valid only during this callback.
      if let url = url, let result = try? Self.save(url: url, declaredType: UTType(identifier)) {
        DispatchQueue.main.async { done(result) }
      } else {
        provider.loadDataRepresentation(forTypeIdentifier: identifier) { data, _ in
          let result = data.flatMap { try? Self.save(data: $0, type: UTType(identifier)) }
          DispatchQueue.main.async {
            if let result = result { done(result) }
            else { self.load(provider: provider, types: types, index: index + 1, done: done) }
          }
        }
      }
    }
  }

  private static func imageType(source: CGImageSource?, declared: UTType?) -> UTType? {
    if let source = source, let identifier = CGImageSourceGetType(source) as String?, let type = UTType(identifier) { return type }
    return declared
  }

  private static func result(size: Int, type: UTType?, file: String) throws -> [String: Any] {
    guard size > 0, let type = type, let mime = type.preferredMIMEType, mime.hasPrefix("image/") else { throw AttachmentError.invalidFile }
    return ["file": file, "name": "Pasted image.\(type.preferredFilenameExtension ?? "img")", "size": size, "mimeType": mime]
  }

  private static func save(url: URL, declaredType: UTType?) throws -> [String: Any] {
    let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
    guard values.isRegularFile == true, let size = values.fileSize else { throw AttachmentError.invalidFile }
    let type = imageType(source: CGImageSourceCreateWithURL(url as CFURL, nil), declared: declaredType)
    if size > 2 * 1024 * 1024 * 1024 { return try result(size: size, type: type, file: "") }
    let id = UUID().uuidString.lowercased()
    let metadata = try result(size: size, type: type, file: id)
    try FileManager.default.createDirectory(at: attachmentDirectory, withIntermediateDirectories: true)
    try FileManager.default.copyItem(at: url, to: attachmentURL(id))
    return metadata
  }

  private static func save(data: Data, type: UTType?) throws -> [String: Any] {
    let actualType = imageType(source: CGImageSourceCreateWithData(data as CFData, nil), declared: type)
    if data.count > 2 * 1024 * 1024 * 1024 { return try result(size: data.count, type: actualType, file: "") }
    let id = UUID().uuidString.lowercased()
    let metadata = try result(size: data.count, type: actualType, file: id)
    try FileManager.default.createDirectory(at: attachmentDirectory, withIntermediateDirectories: true)
    try data.write(to: attachmentURL(id), options: .atomic)
    return metadata
  }

  private func complete(result: [String: Any]? = nil, error: String? = nil) {
    guard !completed else { return }
    completed = true
    let resolve = {
      self.finish()
      if let error = error { self.promise.reject("ERR_KEYLIME_PASTE", error) }
      else { self.promise.resolve(result) }
    }
    if presentingViewController == nil { resolve() }
    else { dismiss(animated: true, completion: resolve) }
  }
}

final class AttachmentPicker: NSObject, UIDocumentPickerDelegate, PHPickerViewControllerDelegate, UIPopoverPresentationControllerDelegate {
  private let promise: Promise
  private let maxPhotoSelection: Int
  private let finish: () -> Void
  private var completed = false
  private var sourceSheet: UIAlertController?
  private var presentedPicker: UIViewController?
  private var savedPhotos: [[String: Any]] = []
  private var photoErrors: [String] = []

  init(promise: Promise, maxPhotoSelection: Int, finish: @escaping () -> Void) {
    self.promise = promise
    self.maxPhotoSelection = max(0, min(30, maxPhotoSelection))
    self.finish = finish
  }

  func present(from controller: UIViewController) {
    let sheet = UIAlertController(title: nil, message: nil, preferredStyle: .actionSheet)
    sourceSheet = sheet
    sheet.addAction(UIAlertAction(title: "Photo Library", style: .default) { [weak self, weak controller] _ in
      self?.chooseSource(from: controller, photos: true)
    })
    sheet.addAction(UIAlertAction(title: "Files", style: .default) { [weak self, weak controller] _ in
      self?.chooseSource(from: controller, photos: false)
    })
    sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in
      self?.complete(results: [])
    })
    if let popover = sheet.popoverPresentationController {
      popover.sourceView = controller.view
      popover.sourceRect = CGRect(x: controller.view.bounds.midX, y: controller.view.bounds.maxY, width: 1, height: 1)
      popover.permittedArrowDirections = []
      popover.delegate = self
    }
    controller.present(sheet, animated: true) {
      sheet.presentationController?.delegate = self
    }
  }

  private func chooseSource(from controller: UIViewController?, photos: Bool) {
    guard let controller = controller, let sheet = sourceSheet else {
      complete(error: "The attachment picker is unavailable.")
      return
    }
    sourceSheet = nil
    sheet.dismiss(animated: true) {
      if photos {
        guard self.maxPhotoSelection > 0 else {
          self.complete(error: "This message has no remaining attachment slots.")
          return
        }
        var configuration = PHPickerConfiguration()
        configuration.filter = .images
        configuration.selectionLimit = self.maxPhotoSelection
        configuration.selection = .ordered
        configuration.preferredAssetRepresentationMode = .compatible
        let picker = PHPickerViewController(configuration: configuration)
        picker.delegate = self
        self.presentedPicker = picker
        controller.present(picker, animated: true) { picker.presentationController?.delegate = self }
      } else {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
        picker.allowsMultipleSelection = true
        picker.delegate = self
        self.presentedPicker = picker
        controller.present(picker, animated: true) { picker.presentationController?.delegate = self }
      }
    }
  }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    if presentationController.presentedViewController === sourceSheet || presentationController.presentedViewController === presentedPicker {
      complete(results: [])
    }
  }

  func popoverPresentationControllerDidDismissPopover(_ popoverPresentationController: UIPopoverPresentationController) {
    if popoverPresentationController.presentedViewController === sourceSheet { complete(results: []) }
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    presentedPicker = nil
    complete(results: [])
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    presentedPicker = nil
    // Copies remain in our cache for retries after the provider's temporary URLs expire.
    DispatchQueue.global(qos: .userInitiated).async {
      var results: [[String: Any]] = []
      var errors: [String] = []
      for url in urls {
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }
        do {
          let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .contentTypeKey])
          guard values.isRegularFile == true, let size = values.fileSize, size >= 0 else { throw AttachmentError.invalidFile }
          if size > 2 * 1024 * 1024 * 1024 {
            results.append(["file": "", "name": url.lastPathComponent, "size": size, "mimeType": values.contentType?.preferredMIMEType ?? "application/octet-stream"])
            continue
          }
          try FileManager.default.createDirectory(at: attachmentDirectory, withIntermediateDirectories: true)
          let id = UUID().uuidString.lowercased()
          let target = try attachmentURL(id)
          do { try FileManager.default.copyItem(at: url, to: target) }
          catch { try? FileManager.default.removeItem(at: target); throw error }
          results.append(["file": id, "name": url.lastPathComponent, "size": size, "mimeType": values.contentType?.preferredMIMEType ?? "application/octet-stream"])
        } catch {
          errors.append("Could not open \(url.lastPathComponent): \(error.localizedDescription)")
        }
      }
      DispatchQueue.main.async { self.complete(results: results, errors: errors) }
    }
  }

  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    presentedPicker = nil
    picker.dismiss(animated: true) {
      guard !results.isEmpty else { self.complete(results: []); return }
      self.loadPhotos(results.map(\.itemProvider), index: 0)
    }
  }

  private func loadPhotos(_ providers: [NSItemProvider], index: Int) {
    guard index < providers.count else { complete(results: savedPhotos, errors: photoErrors); return }
    let provider = providers[index]
    let identifiers = provider.registeredTypeIdentifiers.filter {
      guard let type = UTType($0) else { return false }
      return type.conforms(to: .image)
    }.sorted { left, right in
      (UTType(left)?.conforms(to: .jpeg) == true ? 0 : 1) < (UTType(right)?.conforms(to: .jpeg) == true ? 0 : 1)
    }
    loadPhoto(provider, identifiers: identifiers, index: 0, lastError: nil) { result, error in
      if let result = result {
        self.savedPhotos.append(result)
      } else {
        let name = provider.suggestedName.flatMap { $0.isEmpty ? nil : $0 } ?? "photo \(index + 1)"
        self.photoErrors.append("Could not open \(name): \(error ?? "No image file representation was available.")")
      }
      self.loadPhotos(providers, index: index + 1)
    }
  }

  private func loadPhoto(_ provider: NSItemProvider, identifiers: [String], index: Int, lastError: String?, done: @escaping ([String: Any]?, String?) -> Void) {
    guard index < identifiers.count else { done(nil, lastError); return }
    let identifier = identifiers[index]
    provider.loadFileRepresentation(forTypeIdentifier: identifier) { url, providerError in
      // NSItemProvider removes this URL when the callback returns, including for iCloud assets.
      var result: [String: Any]?
      var failure = providerError?.localizedDescription
      if let url = url {
        do { result = try Self.savePhoto(url: url, declaredType: UTType(identifier), suggestedName: provider.suggestedName) }
        catch { failure = error.localizedDescription }
      }
      DispatchQueue.main.async {
        if let result = result { done(result, nil) }
        else { self.loadPhoto(provider, identifiers: identifiers, index: index + 1, lastError: failure ?? lastError, done: done) }
      }
    }
  }

  private static func savePhoto(url: URL, declaredType: UTType?, suggestedName: String?) throws -> [String: Any] {
    let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
    guard values.isRegularFile == true, let size = values.fileSize, size > 0 else { throw AttachmentError.invalidFile }
    let source = CGImageSourceCreateWithURL(url as CFURL, nil)
    let type = source.flatMap { CGImageSourceGetType($0) as String? }.flatMap { UTType($0) } ?? declaredType
    guard let type = type, let mime = type.preferredMIMEType, mime.hasPrefix("image/") else { throw AttachmentError.invalidFile }
    let ext = type.preferredFilenameExtension ?? "img"
    var name = suggestedName.flatMap { $0.isEmpty ? nil : $0 } ?? url.lastPathComponent
    name = (name as NSString).lastPathComponent
    if name.isEmpty { name = "Photo" }
    let nameExt = (name as NSString).pathExtension
    if nameExt.isEmpty || UTType(filenameExtension: nameExt) != type {
      if let nameType = UTType(filenameExtension: nameExt), nameType.conforms(to: .image) {
        name = (name as NSString).deletingPathExtension
      }
      name += ".\(ext)"
    }
    if size > 2 * 1024 * 1024 * 1024 {
      return ["file": "", "name": name, "size": size, "mimeType": mime]
    }
    let id = UUID().uuidString.lowercased()
    let target = try attachmentURL(id)
    try FileManager.default.createDirectory(at: attachmentDirectory, withIntermediateDirectories: true)
    do { try FileManager.default.copyItem(at: url, to: target) }
    catch { try? FileManager.default.removeItem(at: target); throw error }
    return ["file": id, "name": name, "size": size, "mimeType": mime]
  }

  private func complete(results: [[String: Any]] = [], errors: [String] = [], error: String? = nil) {
    guard !completed else { return }
    completed = true
    sourceSheet = nil
    presentedPicker = nil
    savedPhotos.removeAll()
    photoErrors.removeAll()
    finish()
    if let error = error { promise.reject("ERR_KEYLIME_PICKER", error) }
    else { promise.resolve(["files": results, "errors": errors]) }
  }
}
