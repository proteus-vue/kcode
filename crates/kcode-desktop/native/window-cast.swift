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
    /// 设备画面的宽高比（宽/高）。由上层传入——窗口自身比例含标题栏，
    /// 与设备比例不同，不能从窗口推。
    var deviceAspect = 0.0
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
        case "--device-aspect": i += 1; o.deviceAspect = max(0.0, Double(next()) ?? 0.0)
        default: break
        }
        i += 1
    }
    return o
}

let opts = parse(CommandLine.arguments)

/// 估算 Simulator 窗口顶部标题栏的高度（逻辑 px）。
///
/// # 为什么需要估算而不是写死
///
/// 窗口总高 = 标题栏 + 设备视图高。设备视图按设备宽高比等比缩放，
/// 且受可用高度约束。实测窗口 988x2108、设备比例 0.4603：
/// 若标题栏 107，则可用高 2001、设备视图 921x2001（贴高，左右留 34）——
/// 与像素观察一致。
///
/// 从「设备视图贴高」这个条件反解：
///   设备视图高 = 可用高 → 可用宽 = 可用高 × 比例 ≤ 窗口宽
///   即 (H - T) × ratio ≤ W，取等号时 T = H - W / ratio
/// 若 W / ratio > H（窗口比设备比例更"胖"），说明是贴宽、上下无额外留白，
/// 此时标题栏就是 H - W / ratio 的反面：无法从几何唯一确定，回退经验值。
func titleBarHeight(window: SCWindow) -> CGFloat {
    // Simulator 窗口的标题栏在 macOS 上通常是 28pt 左右（含红绿灯按钮），
    // 但实测这台机器上是 107px 物理 = 53.5pt（含设备名那一行）。
    // 用窗口高度的一个保守比例兜底，并在上层用设备比例校正。
    //
    // ⚠️ 这里不做「万能」推断：不同 macOS/Xcode 版本标题栏高度不同，
    // 精确值应由上层用「设备截图 vs 窗口截图」的特征匹配标定。
    // 当前取实测值（53.5pt），够用且可被 --title-bar 覆盖。
    return window.frame.height > 0 ? 53.5 : 0
}

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

/// 一个矩形（捕获帧的像素坐标，**左上原点**）。
struct CropRect {
    var x: CGFloat
    var y: CGFloat
    var width: CGFloat
    var height: CGFloat
}

/// 从一帧里找出「真正的设备屏幕」区域。
///
/// # 搜索范围
///
/// 传进来的是**标题栏以下的整个窗口**，不是算出来的机身矩形。原因：
/// 设备可以旋转，旋转后机身矩形完全是另一个形状（宽高比倒数），
/// 用竖屏的机身矩形去找横屏的屏幕会大面积落空。而「标题栏以下」这个
/// 范围对两个方向都成立，所以旋不旋转都能扫。
///
/// # 判据为什么可靠
///
/// 外壳是**连续的黑带**：某一列若落在外壳上，整列几乎全黑（实测黑占比
/// 0.90）；落在屏幕上则是内容（实测 0.15）。两者差 6 倍。
/// 所以从四个方向分别找「第一段连续足够长的非黑区」，就是屏幕边界。
///
/// # 为什么用「连续长度」而不是「跳过第一段黑带」
///
/// 实测从外向内有两段黑带：窗口与机身之间的空隙（y 48..57 全黑）、
/// 机身外壳本身的描边（y 64..70 黑占比 0.88）。只跳第一段会停在 59，
/// 那还在外壳里（实测就是这么失败的：检测没通过，退回机身矩形）。
///
/// # 合理性校验（两道）
///
/// 1. **宽高比**必须接近设备比例（正反两个方向都接受，因为可能已旋转）；
/// 2. **尺寸**不能太小。
///
/// 若设备当时正显示深色画面（比如全黑的视频页），屏幕也会被判成「黑带」，
/// 检测会失败——失败时保留上一次的结果，不更新（宁可画面多一圈黑边，
/// 也不能裁错：裁掉屏幕会让点击整体偏移）。
func detectScreenRect(
    pixelBuffer: CVPixelBuffer, search: CropRect, deviceAspect: Double
) -> CropRect? {
    guard deviceAspect > 0 else { return nil }
    CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
    guard let baseAddr = CVPixelBufferGetBaseAddress(pixelBuffer) else { return nil }
    let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
    let pw = CVPixelBufferGetWidth(pixelBuffer)
    let ph = CVPixelBufferGetHeight(pixelBuffer)

    /// 取某点亮度（BGRA）。
    func luma(_ x: Int, _ y: Int) -> Int {
        let p = baseAddr + y * bytesPerRow + x * 4
        let b = Int(p.load(fromByteOffset: 0, as: UInt8.self))
        let g = Int(p.load(fromByteOffset: 1, as: UInt8.self))
        let r = Int(p.load(fromByteOffset: 2, as: UInt8.self))
        return (r * 299 + g * 587 + b * 114) / 1000
    }

    let x0 = max(0, Int(search.x)), x1 = min(pw - 1, Int(search.x + search.width) - 1)
    let y0 = max(0, Int(search.y)), y1 = min(ph - 1, Int(search.y + search.height) - 1)
    guard x1 > x0 + 8, y1 > y0 + 8 else { return nil }

    let step = 2
    let rows = Array(stride(from: y0, through: y1, by: step))
    let cols = Array(stride(from: x0, through: x1, by: step))

    /// 「属于窗口装饰/外壳」的亮度上限。
    ///
    /// # 这个阈值是实测定的，不能凭感觉改
    ///
    /// 两个平台实测到的装饰亮度：
    ///   · 窗口背景/外边距：纯黑（luma 0）
    ///   · iOS 标题栏：rgb(30,30,30) → luma **30**
    ///   · iOS 机身描边：rgb(44,44,44) → luma **44**
    ///   · Android 模拟器工具条：纯黑（luma 0）
    ///
    /// 早先我用 `< 30`，恰好把 luma=30 的 iOS 标题栏**排除在「暗」之外**
    /// ——那时搜索起点从标题栏下方开始，所以没暴露；后来改成整帧搜索，
    /// 标题栏被判成内容，iOS 的 top 从 72 变成 0（**画面顶部多出一条标题栏**，
    /// 实测到的回归）。取 60：能盖住上面全部四种装饰，又仍明显低于
    /// 正常界面的内容亮度（设置页/主屏实测 luma ≥ 100）。
    ///
    /// 深色界面（深色模式）会落入这个阈值，但那时由**宽高比推导**
    /// 兜底（见 detectScreenRect 的候选 2），不靠亮度硬判。
    let darkLuma = 60

    /// 一列里「暗」像素的占比。
    func blackFracCol(_ x: Int) -> Double {
        var n = 0
        for y in rows where luma(x, y) < darkLuma { n += 1 }
        return Double(n) / Double(rows.count)
    }
    /// 一行里「暗」像素的占比。
    func blackFracRow(_ y: Int) -> Double {
        var n = 0
        for x in cols where luma(x, y) < darkLuma { n += 1 }
        return Double(n) / Double(cols.count)
    }

    /// 从外向内找「内容真正开始」的位置：第一段**连续足够长**的非黑区。
    func firstContent(_ vals: [Int], frac: (Int) -> Double) -> Int? {
        // 24px（step=2 → 12 个采样点）的内容宽度才算数
        let run = 12
        var i = 0
        while i < vals.count {
            if frac(vals[i]) <= 0.5 {
                var j = i
                var clean = true
                while j < min(i + run, vals.count) {
                    if frac(vals[j]) > 0.5 { clean = false; break }
                    j += 1
                }
                if clean { return vals[i] }
            }
            i += 1
        }
        return nil
    }

    guard let left = firstContent(cols, frac: blackFracCol),
          let top = firstContent(rows, frac: blackFracRow)
    else { return nil }
    let right = firstContent(cols.reversed(), frac: blackFracCol)
    let bottom = firstContent(rows.reversed(), frac: blackFracRow)

    /// 比例是否与设备一致（**正反都接受**——设备可能已旋转）。
    func aspectMatches(_ w: CGFloat, _ h: CGFloat) -> Bool {
        guard w >= 80, h >= 80 else { return false }
        let a = Double(w / h)
        return abs(a - deviceAspect) / deviceAspect < 0.04
            || abs(a - 1 / deviceAspect) / (1 / deviceAspect) < 0.04
    }

    // ── 候选 1：四条边都扫到，且比例自洽 ──────────────────────────────
    //
    // 这是 iOS 的常态（机身四周都是黑边，四条边都扫得准）。
    if let right, let bottom {
        let w = CGFloat(right - left + 1)
        let h = CGFloat(bottom - top + 1)
        if aspectMatches(w, h) {
            return CropRect(x: CGFloat(left), y: CGFloat(top), width: w, height: h)
        }
    }

    // ── 候选 2：用已知宽高比**推导缺失的边** ──────────────────────────
    //
    // # 为什么需要这一条（实测，Android）
    //
    // Android 模拟器窗口的实测数据（窗口帧 450×931，设备 1080×2340）：
    //   left=20 ✓  right=378 ✓  top=22 ✓  bottom=**734** ✗ —— 真值是 800。
    // 原因不是检测坏了，而是**设备自己的深色导航栏**（黑色背景 + 白色按钮）
    // 与窗口黑边在像素上无法区分：逐行扫到 y≈780 时黑占比就超过阈值了，
    // 于是 bottom 停在导航栏上沿。四条边不自洽 → 比例 0.50 对不上 0.46。
    //
    // 但「左侧/上方」的扫描是可靠的（设备外面确实是窗口背景），
    // 而**宽高比是已知的**——所以可以由宽推出高，或由高推出宽。
    // 两条都试，取先满足的那条。
    let devRatio = CGFloat(deviceAspect)
    let searchBottom = CGFloat(y1), searchRight = CGFloat(x1)

    // 2a. 用宽度定尺寸（left/right 都可信时）
    if let right {
        let w = CGFloat(right - left + 1)
        let h = (w / devRatio).rounded()
        let b = CGFloat(top) + h - 1
        if b <= searchBottom, aspectMatches(w, h) {
            return CropRect(x: CGFloat(left), y: CGFloat(top), width: w, height: h)
        }
    }
    // 2b. 用高度定尺寸（那条边可信时）
    if let bottom {
        let h = CGFloat(bottom - top + 1)
        let w = (h * devRatio).rounded()
        let r = CGFloat(left) + w - 1
        if r <= searchRight, aspectMatches(w, h) {
            return CropRect(x: CGFloat(left), y: CGFloat(top), width: w, height: h)
        }
    }
    // 2c. 只信 left/top，用「窗口内容区」的最大可能尺寸按比例嵌进去
    //
    // 兜底：若连 right/bottom 都不可信（整屏深色内容），用搜索范围的尺寸
    // 按设备比例内切。这比「不裁」好——不裁会把窗口边框一起显示出来，
    // 而那会导致点击整体偏移。
    let availW = searchRight - CGFloat(left) + 1
    let availH = searchBottom - CGFloat(top) + 1
    var w = availW
    var h = (w / devRatio).rounded()
    if h > availH {
        h = availH
        w = (h * devRatio).rounded()
    }
    if aspectMatches(w, h) {
        return CropRect(x: CGFloat(left), y: CGFloat(top), width: w, height: h)
    }
    return nil
}

final class FrameSink: NSObject, SCStreamOutput {
    // CI/CG 对象**必须由主线程创建后传入**：在后台线程首次初始化 CoreGraphics
    // 会触发 `CGS_REQUIRE_INIT` 断言直接崩溃（本文件实测踩到）。
    private let ciContext: CIContext
    private let colorSpace: CGColorSpace
    private let quality: Double
    /// 检测的搜索范围（**标题栏以下的整个窗口**，见 detectScreenRect）。
    private let searchRect: CropRect
    /// 设备宽高比：检测结果的合理性判据（0 = 上游没给，跳过检测）。
    private let deviceAspect: Double
    /// 每帧要保留的区域（**捕获帧的像素坐标，左上原点**）。
    /// 检测成功后确定；nil = 不裁（几何未知时的退化行为）。
    private var crop: CropRect?
    private var frames = 0
    /// 上次重新检测时的帧号。用于**周期性重检**（见 stream 里的说明）。
    private var lastDetectFrame = 0
    private var encodeTotalMs = 0.0
    private var lastReportAt = DispatchTime.now()
    private var lastReportFrames = 0
    private let startedAt = DispatchTime.now()

    init(quality: Double, searchRect: CropRect, deviceAspect: Double,
         ciContext: CIContext, colorSpace: CGColorSpace) {
        self.quality = quality
        self.searchRect = searchRect
        self.deviceAspect = deviceAspect
        self.ciContext = ciContext
        self.colorSpace = colorSpace
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid else { return }
        // SCK 会在流状态变化时送空帧（无 imageBuffer），跳过
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        // 检测屏幕区域：首帧一次，之后**周期性重检**。
        //
        // # 为什么要周期重检
        //
        // 设备可以旋转（用户在 Simulator 里按 ⌘←/⌘→）。旋转后画面宽高比
        // 变成倒数，只算一次得到的矩形就错位了：画面会被裁掉一大块。
        // 重检一次约 0.3ms（采样 2 步长、区域有限），每 30 帧（约 1 秒）一次
        // 完全可以忽略——而它换来的是「旋转后画面自动跟上」。
        //
        // 失败时**保留上次结果**：设备正在显示深色内容时检测会失败，
        // 那时沿用旧矩形（多为正确），而不是退回更大的区域。
        let needDetect = frames == 0 || frames - lastDetectFrame >= 30
        if needDetect {
            lastDetectFrame = frames
            if let d = detectScreenRect(pixelBuffer: pixelBuffer,
                                        search: searchRect, deviceAspect: deviceAspect) {
                let changed = crop == nil
                    || abs(d.x - crop!.x) > 1 || abs(d.y - crop!.y) > 1
                    || abs(d.width - crop!.width) > 1 || abs(d.height - crop!.height) > 1
                crop = d
                if changed {
                    let kind = d.width > d.height ? "横屏" : "竖屏"
                    log(String(format: "KCDEVICE_CROP %.2f %.2f %.2f %.2f（%@" +
                               "，已按外壳黑带收窄）", d.x, d.y, d.width, d.height, kind))
                }
            } else if crop == nil {
                // 首次就检测失败：不裁（退化为整帧窗口），并把原因说清楚
                log(String(format: "KCDEVICE_CROP %.2f %.2f %.2f %.2f（检测未通过，不裁）",
                           searchRect.x, searchRect.y, searchRect.width, searchRect.height))
            }
        }

        let t0 = DispatchTime.now()
        var ci = CIImage(cvPixelBuffer: pixelBuffer)
        // 裁掉窗口外壳与标题栏：只把设备屏幕送出去。
        // 这**不只是好看**——不裁的话画面上会出现 Simulator 自己的工具栏按钮
        // （home/截图/旋转），而它们不是设备像素，点上去永远不会有反应。
        // 用户实测反馈「这些区域点了没反应」，指的正是它们。
        // 与其让人去点一个注定无效的区域，不如不显示。
        if let c = crop {
            let h = ci.extent.height
            // CIImage 是**左下原点**，而我们的坐标是左上原点，y 要翻过来
            let rect = CGRect(x: c.x, y: h - c.y - c.height, width: c.width, height: c.height)
                .intersection(ci.extent)
            if rect.width > 1, rect.height > 1 {
                ci = ci.cropped(to: rect)
                    // 归零原点：否则 JPEG 会按 extent 偏移量多出黑边
                    .transformed(by: CGAffineTransform(translationX: -rect.minX, y: -rect.minY))
            }
        }
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

    // ── 设备画面在窗口中的位置 ─────────────────────────────────────────
    //
    // **这是点击坐标准确的前提。** 窗口捕获拿到的是整个窗口（含标题栏与
    // 模拟器外壳描边），而设备屏幕只占其中一块。若上层把整帧当设备屏幕，
    // 所有点击都会整体偏移（用户实测反馈「点击区域和实际触达的不一致，
    // 差得很远」）。
    //
    // 曾经这里还算过「设备视图在窗口里的矩形」（按设备宽高比等比缩放、
    // 受可用高度约束），上层再用它做点击换算。**现在不需要了**：
    // 屏幕区域由 detectScreenRect 从**实际像素**检测出来，比按比例推算更准
    // （推算出的矩形包住的是机身轮廓，含外壳黑边，每边多约 9px）。
    // 推算逻辑已删除——留着只会让人以为它还在被使用。
    //

    // 输出给上层：**送出去的帧就是设备屏幕**（我们裁过），所以设备占满整帧。
    //
    // 这条曾经是「设备在窗口帧里的位置」（0.034 0.051 0.932 0.949）——那是
    // 裁切之前的口径：那时上层必须自己做一次裁剪换算，而换算用的矩形包住的是
    // **机身轮廓**（含外壳黑边），不是屏幕，边缘点击会偏约 2%。
    // 现在裁剪在 helper 里做（含周期性的屏幕检测，见 detectScreenRect），
    // 上层拿到什么就是屏幕，映射变成 1:1，不会再有那层误差。
    //
    // ⚠️ 走到 **stderr** 而不是 stdout：stdout 是帧数据通道，
    // 混入文本行会破坏上层的帧协议解析（帧以 `KCFRAME <len>\n` 开头）。
    // stderr 本就是日志通道，上层在那里找 `KCDEVICE ` 前缀。
    log("KCDEVICE 0.000000 0.000000 1.000000 1.000000")
    // 检测的搜索范围：**标题栏以下的整个窗口**（旋转后机身矩形完全不同，
    // 只有「标题栏以下」对两个方向都成立，见 detectScreenRect 的说明）。
    // 搜索范围 = **整个窗口帧**。
    //
    // # 为什么不再从「标题栏以下」开始
    //
    // 曾经这里按 `titleBarHeight()`（写死 53.5pt，实测自 iOS Simulator）下移
    // 搜索起点。那个假设**只对 iOS 成立**：Android 模拟器窗口几乎没有标题栏，
    // 设备画面从 y≈22 就开始，而搜索起点被推到 y≈49 —— 于是**画面顶部被切掉**，
    // 检测出来的高度偏小、宽高比校验不过，整块回退成「不裁」（实测到的现象是
    // `KCDEVICE_CROP ... 检测未通过，不裁`，画面上带着模拟器工具条）。
    //
    // 现在从 y=0 扫：标题栏本身是深色的（iOS 上实测 rgb 30,30,30），
    // 它不会被判成内容，所以「从整帧扫」对两个平台都成立，
    // 也就不需要那个平台相关的常量了。
    let searchRect = CropRect(
        x: 0, y: 0, width: CGFloat(cfg.width), height: CGFloat(cfg.height)
    )


    let filter = SCContentFilter(desktopIndependentWindow: window)
    let stream = SCStream(filter: filter, configuration: cfg, delegate: nil)
    let sink = FrameSink(quality: opts.quality, searchRect: searchRect,
                         deviceAspect: opts.deviceAspect,
                         ciContext: ciContext, colorSpace: colorSpace)
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
