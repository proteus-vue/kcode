// 常驻帧源探针：验证「注册 frame callback → 推送帧」能否达到高帧率。
//
// ⚠️ **这个文件不参与构建、也不进产物**（只有 `sim-hid.swift` 会被
// `scripts/build-sim-hid.sh` 编译）。保留在仓库里的唯一理由是：里面的注释
// 记录了这条路上几个**代价很高才发现**的事实。
//
// ⚠️ **当前状态：跑不通**。走到了「端口与描述符都对（`surface=true`
// `registerCallbacks=true`），但 surface 从未填充、回调从未触发」。
// 已知障碍：那个 descriptor 是 `ROCKRemoteProxy`（跨进程代理），方法由
// Objective-C 运行时转发到模拟器进程，`class_getMethodImplementation`
// 拿到的是本地转发桩；改用 `objc_msgSend` 真实发送仍未触发。
// 完整复盘与未决原因见 docs/协议勘误与修正.md §3.42。
//
// 所以：**不要把它接进构建或产物**——它还没验证成功。
//
// # 为什么要常驻
//
// 实测：`simctl io screenshot` 每帧要 **116–118ms**，而进程启动只需 2.8ms、
// 截图本身只占 2ms —— 也就是说 116ms 全花在**每次重新初始化 CoreSimulator**。
// 常驻进程只付一次（首次实测 237–330ms），之后每帧只剩「取 surface + 编码」。
//
// # 推送而非轮询
//
// SimulatorKit 通过 `registerScreenCallbacksWithUUID:...` 注册回调，
// 显示管线有新帧时会**主动通知**（这是 Simulator.app 自己的路径）。
// 所以帧率不再受我轮询节奏限制。
//
// 用法：
//   kcode-sim-cast --udid <UDID> [--developer-dir DIR] [--fps N] [--scale N]
// 输出：JPEG 帧写入 stdout，每帧一行 `KCFRAME <字节数>\n` 作为分隔（便于上层解析）。

import CoreGraphics
import Foundation
import IOSurface
import ImageIO
import ObjectiveC
import UniformTypeIdentifiers
import Darwin

// MARK: - 参数

struct Opts {
    var udid = ""
    var developerDir = ""
    var fps = 30
    var scale = 2          // 1 = 原始分辨率，2 = 一半（默认，省一半编码与传输）
    var durationMs = 0     // 0 = 一直跑
}

func parse(_ argv: [String]) -> Opts {
    var o = Opts()
    var i = 1
    while i < argv.count {
        switch argv[i] {
        case "--udid": i += 1; o.udid = i < argv.count ? argv[i] : ""
        case "--developer-dir": i += 1; o.developerDir = i < argv.count ? argv[i] : ""
        case "--fps": i += 1; o.fps = max(1, min(60, Int(i < argv.count ? argv[i] : "30") ?? 30))
        case "--scale": i += 1; o.scale = max(1, min(4, Int(i < argv.count ? argv[i] : "2") ?? 2))
        case "--duration": i += 1; o.durationMs = max(0, Int(i < argv.count ? argv[i] : "0") ?? 0)
        default: break
        }
        i += 1
    }
    return o
}

let opts = parse(CommandLine.arguments)
guard !opts.udid.isEmpty else {
    FileHandle.standardError.write("错误：需要 --udid\n".data(using: .utf8)!)
    exit(2)
}

func log(_ m: String) {
    FileHandle.standardError.write((m + "\n").data(using: .utf8)!)
}

// MARK: - 私有框架

func resolveDeveloperDir(_ from: String) -> String {
    if !from.isEmpty { return from }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
    p.arguments = ["-p"]
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = Pipe()
    try? p.run()
    p.waitUntilExit()
    let d = pipe.fileHandleForReading.readDataToEndOfFile()
    return String(data: d, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
}

let devDir = resolveDeveloperDir(opts.developerDir)

/// dlopen 私有框架。CoreSimulator 可能在系统或 Xcode 内；
/// SimulatorKit 的位置在 Xcode 27 变过（本函数两条路径都试）。
func loadFrameworks() {
    var paths = ["/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator"]
    if !devDir.isEmpty {
        paths.append("\(devDir)/Library/PrivateFrameworks/CoreSimulator.framework/CoreSimulator")
        paths.append("\(devDir)/../SharedFrameworks/SimulatorKit.framework/SimulatorKit")
        paths.append("\(devDir)/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit")
    }
    // 用 RTLD_NOW（**不带 RTLD_GLOBAL**），与参考实现对齐：
    // 加载符号到本进程即可，不需要导出给全局命名空间。
    for p in paths { _ = dlopen(p, RTLD_NOW) }
}

loadFrameworks()

// MARK: - 找设备与 framebuffer 描述符

func findDevice() -> NSObject? {
    guard let cls = NSClassFromString("SimServiceContext") as? NSObject.Type else { return nil }
    guard let ctx = cls.perform(NSSelectorFromString("sharedServiceContextForDeveloperDir:error:"),
                                with: devDir, with: nil)?.takeUnretainedValue() as? NSObject,
          let set = ctx.perform(NSSelectorFromString("defaultDeviceSetWithError:"), with: nil)?
            .takeUnretainedValue() as? NSObject,
          let devices = set.value(forKey: "devices") as? [NSObject]
    else { return nil }
    return devices.first {
        ($0.value(forKey: "UDID") as? NSUUID)?.uuidString.caseInsensitiveCompare(opts.udid) == .orderedSame
    }
}

/// 取 io 端口列表。
///
/// ⚠️ 两个必须知道的细节（都来自实测）：
///
/// 1. **必须先 `updateIOPorts`**。端口描述符是**懒创建**的：不刷新就拿不到
///    `com.apple.framebuffer.display` 端口（只有 HID/Audio/gputools 那些）。
///    本探针第一版就是漏了这步，报「找不到 framebuffer 描述符」。
/// 2. 用 `ioPorts` 这个**无参 selector**，不要用 KVC 的 `deviceIOPorts`：
///    名字看起来对，但 KVC 取值会抛 `NSUnknownKeyException` 直接终止进程。
func ioPorts(_ io: NSObject) -> [NSObject] {
    // 刷新端口（懒创建）
    if io.responds(to: NSSelectorFromString("updateIOPorts")) {
        _ = io.perform(NSSelectorFromString("updateIOPorts"))
    }
    guard let ports = io.perform(NSSelectorFromString("ioPorts"))?.takeUnretainedValue() as? [NSObject]
    else { return [] }
    return ports
}

func ioClient(_ device: NSObject) -> NSObject? {
    device.perform(NSSelectorFromString("io"))?.takeUnretainedValue() as? NSObject
}

// MARK: - 注册帧回调

/// 与 SimulatorKit 的 `registerScreenCallbacks` 对齐的协议。
///
/// 这个方法是**推送模型的关键**：注册后 SimulatorKit 才会把显示管线接到
/// 本进程，并在有新帧时调用 `frameCallback`。
@objc protocol FramebufferDescriptor {
    @objc(registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:)
    func registerScreenCallbacks(
        uuid: UUID,
        callbackQueue: DispatchQueue,
        frameCallback: @convention(block) @escaping () -> Void,
        surfacesChangedCallback: @convention(block) @escaping () -> Void,
        propertiesChangedCallback: @convention(block) @escaping () -> Void
    )
}

final class FrameSource {
    private let queue = DispatchQueue(label: "kcode.cast")
    private var surface: IOSurface?
    private var lastFrameAt = DispatchTime.now()
    private let minIntervalNs: UInt64
    private var frames = 0
    private var startedAt = DispatchTime.now()

    /// 有新帧时调用（由 SimulatorKit 的显示管线触发）。
    var onFrame: (() -> Void)?

    init(fps: Int) {
        minIntervalNs = fps > 0 ? UInt64(1_000_000_000 / fps) : 0
    }

    func attach(descriptor: NSObject) throws {
        let sel = #selector(FramebufferDescriptor.registerScreenCallbacks(uuid:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:))
        guard descriptor.responds(to: sel) else {
            throw NSError(domain: "kcode-cast", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "descriptor 不响应 registerScreenCallbacks",
            ])
        }

        let frameBlock: @convention(block) () -> Void = { [weak self] in
            self?.handlePush()
        }
        let surfacesBlock: @convention(block) () -> Void = { [weak self] in
            self?.handlePush()
        }
        let propsBlock: @convention(block) () -> Void = {}

        // ⚠️ 必须走 `objc_msgSend` 的**真实消息发送**，不能用
        // `class_getMethodImplementation` + 强转函数指针。
        //
        // 原因：这个 descriptor 是 `ROCKRemoteProxy`（跨进程代理），
        // 它的方法由 Objective-C 运行时**转发**到模拟器进程。
        // `class_getMethodImplementation` 拿到的是本地转发桩，直接强转调用
        // 会得到一个空操作——注册"成功"了但回调永远不来（本探针实测：
        // surface 一直未填充、帧率恒为 0）。
        //
        // 用 objc_msgSend 才会触发完整转发链。
        typealias MsgSendFunc = @convention(c) (
            AnyObject, Selector, NSUUID, DispatchQueue,
            @convention(block) () -> Void,
            @convention(block) () -> Void,
            @convention(block) () -> Void
        ) -> Void
        guard let handle = dlopen(nil, RTLD_NOW),
              let sym = dlsym(handle, "objc_msgSend") else {
            throw NSError(domain: "kcode-cast", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "取不到 objc_msgSend",
            ])
        }
        let msgSend = unsafeBitCast(sym, to: MsgSendFunc.self)
        msgSend(descriptor, sel, UUID() as NSUUID, queue, frameBlock, surfacesBlock, propsBlock)

        if let s = readSurface(descriptor) {
            surface = s
        }
    }

    private func readSurface(_ descriptor: NSObject) -> IOSurface? {
        let sel = NSSelectorFromString("framebufferSurface")
        guard descriptor.responds(to: sel),
              let o = descriptor.perform(sel)?.takeUnretainedValue()
        else { return nil }
        return unsafeBitCast(o, to: IOSurface.self)
    }

    /// 帧推送回调：按 fps 节流后转给 onFrame。
    private func handlePush() {
        let now = DispatchTime.now()
        let elapsed = now.uptimeNanoseconds - lastFrameAt.uptimeNanoseconds
        if minIntervalNs > 0 && elapsed < minIntervalNs { return }
        lastFrameAt = now
        onFrame?()
    }

    func currentSurface() -> IOSurface? { surface }

    func stats() -> (frames: Int, seconds: Double) {
        let secs = Double(DispatchTime.now().uptimeNanoseconds - startedAt.uptimeNanoseconds) / 1e9
        return (frames, secs)
    }
    func bump() { frames += 1 }
}

// MARK: - 主流程

guard let device = findDevice() else {
    log("错误：找不到设备 \(opts.udid)")
    exit(4)
}
let state = device.value(forKey: "stateString") as? String ?? "unknown"
guard state == "Booted" else {
    log("错误：设备未启动（状态：\(state)）")
    exit(5)
}

guard let io = ioClient(device) else {
    log("错误：取不到 device.io")
    exit(6)
}
let ports = ioPorts(io)
log("io 端口 \(ports.count) 个（已 updateIOPorts）")

// 找 framebuffer 描述符：按 portIdentifier 含 framebuffer，且 descriptor
// 真的响应 framebufferSurface（两者都要，缺一不可——代理对象可能不响应）
var descriptor: NSObject?
var sawFramebufferPort = false
for port in ports {
    guard port.responds(to: NSSelectorFromString("portIdentifier")),
          let pid = port.perform(NSSelectorFromString("portIdentifier"))?.takeUnretainedValue()
    else { continue }
    let name = "\(pid)"
    log("  端口: \(name)")
    if name.contains("framebuffer") { sawFramebufferPort = true }
    guard name.contains("framebuffer"),
          let d = port.perform(NSSelectorFromString("descriptor"))?.takeUnretainedValue() as? NSObject
    else { continue }
    let hasSurf = d.responds(to: NSSelectorFromString("framebufferSurface"))
    let hasReg = d.responds(to: #selector(FramebufferDescriptor.registerScreenCallbacks(uuid:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:)))
    log("  → framebuffer 端口: surface=\(hasSurf) registerCallbacks=\(hasReg)")
    if hasSurf { descriptor = d; break }
}
guard let desc = descriptor else {
    if sawFramebufferPort {
        log("错误：有 framebuffer 端口但描述符不响应 framebufferSurface（版本差异）")
    } else {
        log("错误：没有 com.apple.framebuffer.display 端口（模拟器可能未显示任何画面）")
    }
    exit(7)
}

let source = FrameSource(fps: opts.fps)
do {
    try source.attach(descriptor: desc)
} catch {
    log("错误：\(error.localizedDescription)")
    exit(7)
}

let colorSpace = CGColorSpaceCreateDeviceRGB()

/// 把 surface 编成 JPEG。
///
/// 用 IOSurface 的像素缓冲直接建 CGImage（**零拷贝**），再缩放 → JPEG。
/// 缩放是必要的：原始 1179×2556 编码要 40ms+，缩一半降到 10ms 量级，
/// 而面板显示宽度只有 400px 左右，肉眼无差别。
func encode(_ surf: IOSurface) -> Data? {
    IOSurfaceLock(surf, [], nil)
    defer { IOSurfaceUnlock(surf, [], nil) }
    let w = IOSurfaceGetWidth(surf)
    let h = IOSurfaceGetHeight(surf)
    let bpr = IOSurfaceGetBytesPerRow(surf)
    let base = IOSurfaceGetBaseAddress(surf)
    let bmp = CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
    guard w > 0, h > 0,
          let ctx = CGContext(data: base, width: w, height: h, bitsPerComponent: 8,
                              bytesPerRow: bpr, space: colorSpace, bitmapInfo: bmp),
          let img = ctx.makeImage()
    else { return nil }

    let ow = max(1, w / opts.scale)
    let oh = max(1, h / opts.scale)
    guard let out = CGContext(data: nil, width: ow, height: oh, bitsPerComponent: 8,
                              bytesPerRow: 0, space: colorSpace,
                              bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
                                | CGBitmapInfo.byteOrder32Little.rawValue)
    else { return nil }
    out.interpolationQuality = .low
    out.draw(img, in: CGRect(x: 0, y: 0, width: ow, height: oh))
    guard let scaled = out.makeImage() else { return nil }

    let data = NSMutableData()
    guard let dst = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil)
    else { return nil }
    CGImageDestinationAddImage(dst, scaled, [kCGImageDestinationLossyCompressionQuality: 0.65] as CFDictionary)
    guard CGImageDestinationFinalize(dst) else { return nil }
    return data as Data
}

let out = FileHandle.standardOutput
let statsQueue = DispatchQueue(label: "kcode.cast.stats")

// 帧输出：`KCFRAME <长度>\n` + 二进制 JPEG。
// 用长度前缀而不是 base64：省 33% 带宽，且上行解析简单。
func emit(_ jpeg: Data) {
    var header = "KCFRAME \(jpeg.count)\n".data(using: .utf8)!
    out.write(header)
    out.write(jpeg)
    header.removeAll()
}

var encodeTimes: [Double] = []

source.onFrame = { [weak source] in
    guard let source, let surf = source.currentSurface() else { return }
    let t0 = DispatchTime.now()
    guard let jpeg = encode(surf) else { return }
    let ms = Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1e6
    encodeTimes.append(ms)
    if encodeTimes.count > 60 { encodeTimes.removeFirst() }
    source.bump()
    emit(jpeg)
}

// 首帧：注册后可能没有推送，主动取一次
if let surf = source.currentSurface(), let jpeg = encode(surf) {
    source.bump()
    emit(jpeg)
    log("已发首帧")
} else {
    log("首帧取不到（surface 尚未填充，等回调）")
}

let (f, s) = source.stats()
log("已连接：\(f) 帧 / \(String(format: "%.2f", s))s")

// 周期性报告帧率与编码耗时（给上层判断用）
let reporter = DispatchSource.makeTimerSource(queue: statsQueue)
var lastReported = 0
reporter.schedule(deadline: .now() + 2, repeating: 2)
reporter.setEventHandler {
    let (frames, secs) = source.stats()
    let delta = frames - lastReported
    lastReported = frames
    let avg = encodeTimes.isEmpty ? 0 : encodeTimes.reduce(0, +) / Double(encodeTimes.count)
    log(String(format: "STATS fps=%.1f total=%d 编码均值=%.1fms",
               Double(delta) / 2.0, frames, avg))
}
reporter.resume()

if opts.durationMs > 0 {
    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(opts.durationMs)) {
        exit(0)
    }
}

RunLoop.main.run()
