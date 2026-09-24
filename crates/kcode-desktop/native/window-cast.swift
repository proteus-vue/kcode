// 常驻窗口帧源：用 ScreenCaptureKit 持续抓一个窗口，输出 JPEG 帧到 stdout。
//
// # 为什么是「窗口捕获」这条路
//
// 实测数据（决定了方向）：
//
// | 方式 | 每帧耗时 |
// |---|---|
// | `simctl list devices`（纯查询，不截图） | 116ms |
// | `simctl io screenshot` | 118ms |
// | `screencapture -l <窗口>` | 266ms |
//
// **116ms 全在「每次重新初始化」上**（进程启动只要 2.8ms）。所以不管用
// simctl 还是 screencapture，只要「一帧一个进程」就注定慢。
// 而 ScreenCaptureKit 的模型是**常驻流**：抓一次窗口，之后由系统持续推送帧
// （被捕获的进程零感知，这就是 serve-sim 说的 out-of-band）。
//
// 选窗口捕获而不是 Apple 私有帧回调，还有两个理由：
//   1. **全公开 API**（ScreenCaptureKit 自 macOS 12.3 起公开）；
//   2. **三个平台通用** —— 模拟器、Android 模拟器、开发者工具窗口都是普通窗口，
//      一条通道全解决。
//
// 代价：需要「屏幕录制」权限（系统设置里给一次）。私有 API 不需要权限，
// 但那条路实测没打通（见 sim-cast.swift 的说明）。
//
// 用法：
//   kcode-window-cast --window <id> [--fps 30] [--width 450] [--duration MS]
// 输出：`KCFRAME <长度>\n` + JPEG 字节（长度前缀而非 base64，省 33% 带宽）。

import CoreGraphics
import CoreImage
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit

// MARK: - 参数

struct Opts {
    var windowID: UInt32 = 0
    var fps = 30
    var targetWidth = 450
    var durationMs = 0
    var quality = 0.6
}

func parse(_ argv: [String]) -> Opts {
    var o = Opts()
    var i = 1
    while i < argv.count {
        let next: () -> String = { i < argv.count ? argv[i] : "" }
        switch argv[i] {
        case "--window": i += 1; o.windowID = UInt32(next()) ?? 0
        case "--fps": i += 1; o.fps = max(1, min(60, Int(next()) ?? 30))
        case "--width": i += 1; o.targetWidth = max(120, min(2000, Int(next()) ?? 450))
        case "--duration": i += 1; o.durationMs = max(0, Int(next()) ?? 0)
        case "--quality": i += 1; o.quality = max(0.1, min(1.0, Double(next()) ?? 0.6))
        default: break
        }
        i += 1
    }
    return o
}

let opts = parse(CommandLine.arguments)

func log(_ m: String) {
    FileHandle.standardError.write((m + "\n").data(using: .utf8)!)
}

// `--list`：列出候选窗口（供上层定位要抓哪个）。
// 放在 helper 里而不是让上层自己查：**避免多一个依赖**——
// 早期用 `/usr/bin/python3 -c "import Quartz"`，而系统自带的 python3
// 没有 pyobjc，于是「找窗口」永远失败（实测踩到）。
if CommandLine.arguments.contains("--list") {
    let sem = DispatchSemaphore(value: 0)
    Task {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            for w in content.windows {
                guard w.frame.width >= 150, w.frame.height >= 150 else { continue }
                let owner = w.owningApplication?.applicationName ?? "?"
                print("\(w.windowID)\t\(owner)\t\(Int(w.frame.width))x\(Int(w.frame.height))")
            }
        } catch {
            log("错误：\(error.localizedDescription)")
        }
        sem.signal()
    }
    sem.wait()
    exit(0)
}

guard opts.windowID != 0 else {
    log("错误：需要 --window <窗口号>，或用 --list 查看候选")
    exit(2)
}

// MARK: - 帧输出

let out = FileHandle.standardOutput
let lock = NSLock()

func emit(_ jpeg: Data) {
    lock.lock()
    defer { lock.unlock() }
    out.write("KCFRAME \(jpeg.count)\n".data(using: .utf8)!)
    out.write(jpeg)
}

// MARK: - 画面输出回调

final class FrameSink: NSObject, SCStreamOutput {
    // CI/CG 对象**必须由主线程创建后传入**：在后台线程首次初始化 CoreGraphics
    // 会触发 `CGS_REQUIRE_INIT` 断言直接崩溃（本文件实测踩到）。
    private let ciContext: CIContext
    private let colorSpace: CGColorSpace
    private let quality: Double
    private var frames = 0
    private var encodeTotalMs = 0.0
    private var lastReportAt = DispatchTime.now()
    private var lastReportFrames = 0
    private let startedAt = DispatchTime.now()

    init(quality: Double, ciContext: CIContext, colorSpace: CGColorSpace) {
        self.quality = quality
        self.ciContext = ciContext
        self.colorSpace = colorSpace
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid else { return }
        // SCK 会在流状态变化时送空帧（无 imageBuffer），跳过
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        let t0 = DispatchTime.now()
        let ci = CIImage(cvPixelBuffer: pixelBuffer)
        guard let data = ciContext.jpegRepresentation(
            of: ci, colorSpace: colorSpace,
            options: [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): quality]
        ) else { return }
        let ms = Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1e6
        encodeTotalMs += ms
        frames += 1
        emit(data)

        // 每 2 秒报告一次（给上层判断用；也用于探针验收）
        let now = DispatchTime.now()
        let elapsed = Double(now.uptimeNanoseconds - lastReportAt.uptimeNanoseconds) / 1e9
        if elapsed >= 2 {
            let delta = frames - lastReportFrames
            let avg = frames > 0 ? encodeTotalMs / Double(frames) : 0
            let total = Double(now.uptimeNanoseconds - startedAt.uptimeNanoseconds) / 1e9
            log(String(format: "STATS fps=%.1f total=%d 编码均值=%.1fms 已运行=%.1fs",
                       Double(delta) / elapsed, frames, avg, total))
            lastReportAt = now
            lastReportFrames = frames
        }
    }
}

// MARK: - 主流程

func run(ciContext: CIContext, colorSpace: CGColorSpace) async throws {
    let content: SCShareableContent
    do {
        content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    } catch {
        log("错误：取窗口列表失败（多半是缺「屏幕录制」权限）：\(error.localizedDescription)")
        log("  修复：系统设置 → 隐私与安全性 → 屏幕录制 → 勾选运行本程序的终端/应用")
        exit(3)
    }

    guard let window = content.windows.first(where: { $0.windowID == opts.windowID }) else {
        log("错误：找不到窗口 \(opts.windowID)")
        let nearby = content.windows.filter { $0.frame.width > 150 && $0.frame.height > 150 }.prefix(8)
        for w in nearby {
            log("  候选: \(w.windowID) \(w.owningApplication?.applicationName ?? "?") \(Int(w.frame.width))x\(Int(w.frame.height))")
        }
        exit(4)
    }
    log("已选中窗口 \(opts.windowID)（\(window.owningApplication?.applicationName ?? "?") \(Int(window.frame.width))x\(Int(window.frame.height))）")

    let scale = CGFloat(window.frame.width) > 0 ? CGFloat(opts.targetWidth) / window.frame.width : 0.5

    let cfg = SCStreamConfiguration()
    // 让 SCK 自己缩放到目标宽度（GPU 缩放，几乎免费），而不是我收大图再缩
    cfg.width = Int(window.frame.width * scale)
    cfg.height = Int(window.frame.height * scale)
    cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(opts.fps))
    cfg.pixelFormat = kCVPixelFormatType_32BGRA
    cfg.queueDepth = 5
    cfg.showsCursor = false
    cfg.capturesAudio = false
    // 保持宽高比；SCK 默认按配置的宽高拉伸，这里不让它变形
    cfg.scalesToFit = true

    let filter = SCContentFilter(desktopIndependentWindow: window)
    let stream = SCStream(filter: filter, configuration: cfg, delegate: nil)
    let sink = FrameSink(quality: opts.quality, ciContext: ciContext, colorSpace: colorSpace)
    try stream.addStreamOutput(sink, type: .screen, sampleHandlerQueue: DispatchQueue(label: "kcode.cast.frames"))

    let t0 = DispatchTime.now()
    try await stream.startCapture()
    log(String(format: "流已启动（耗时 %.0fms）→ 输出 \(cfg.width)x\(cfg.height) @ \(opts.fps)fps",
               Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1e6))

    if opts.durationMs > 0 {
        try await Task.sleep(nanoseconds: UInt64(opts.durationMs) * 1_000_000)
        try? await stream.stopCapture()
        exit(0)
    }

    // 常驻：不退出（由上层 kill）
    while true {
        try await Task.sleep(nanoseconds: 60 * 1_000_000_000)
    }
}

// ⚠️ 在主线程先初始化 CoreGraphics 与 CIContext。
//
// 原因：SCK 的帧回调跑在后台队列上，而 CoreGraphics 若**首次**被后台线程使用
// 会触发 `Assertion failed: CGS_REQUIRE_INIT` 直接终止进程。
// 另外 `Task {}` 里的代码默认跑在协作线程池（非主线程），所以初始化必须
// 摆在 Task 之外的主线程上，再把结果传进去。
_ = CGMainDisplayID()
let ciContext = CIContext(options: [.useSoftwareRenderer: false])
let colorSpace = CGColorSpaceCreateDeviceRGB()

let sem = DispatchSemaphore(value: 0)
Task {
    do {
        try await run(ciContext: ciContext, colorSpace: colorSpace)
    } catch {
        log("错误：\(error.localizedDescription)")
        exit(5)
    }
    sem.signal()
}
sem.wait()
RunLoop.main.run()
