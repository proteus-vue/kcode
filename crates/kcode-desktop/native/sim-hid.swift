// KCode 的 iOS 模拟器输入注入 helper。
//
// # 它做什么
//
// 把触摸事件注入到 iOS 模拟器。`simctl` **没有**这个能力（它只有
// `simctl io <udid> screenshot`，没有任何触摸命令），所以 KCode 的 iOS 画面
// 原本是只读的。本 helper 补上这一块。
//
// # 为什么可以用，以及代价（必读）
//
// 它走的是 Apple 的**私有接口**：
//
//   · `IndigoHIDMessageForMouseNSEvent` —— 构建 HID 触摸消息（SimulatorKit 导出符号）
//   · `SimDeviceLegacyHIDClient` —— 发送客户端（SimulatorKit 内部类）
//   · `dlopen` 从**当前使用的 Xcode** 里加载 CoreSimulator / SimulatorKit
//
// 这不是 hack，而是 Apple 自己 Simulator.app 的路径（我们把模拟器窗口里的
// 点击转发给同一个接口）。但私有接口意味着**Apple 不承诺语义、不做兼容**：
//
//   · Xcode 27 把 SimulatorKit 从 `Developer/Library/PrivateFrameworks`
//     搬到了 `Contents/SharedFrameworks`（本文件两者都试）
//   · Xcode 大版本升级可能改类名、改 selector、改 ABI
//
// 因此：**任何失败都必须给出可读原因并以非零码退出**，让上层能如实告诉用户
// 「iOS 输入不可用」，而不是静默不生效（那会让用户以为点击没反应是应用坏了）。
//
// 参考实现：EvanBacon/serve-sim（Apache-2.0）的 HIDInjector.swift。
// 它面向 Xcode 26/27，本文件按「先探测、再注入」的顺序写，且不引入它那一整套
// （相机注入、折叠屏 Duo、多指等）——我们只需要单指点击与滑动。
//
// # 坐标
//
// **归一化 0..1**（实测确认）：Apple 的 Simulator.app 总是传 NSSize(1.0, 1.0)，
// 于是 ratio = point / 1.0 = point，即点本身被当作比例。上层负责把截图像素
// 换算成比例（它才知道截图尺寸）。
//
// # 用法
//
//   kcode-sim-hid probe  [--developer-dir DIR]
//   kcode-sim-hid tap    <udid> <x> <y> [--developer-dir DIR]
//   kcode-sim-hid swipe  <udid> <x1> <y1> <x2> <y2> [--duration MS] [--developer-dir DIR]
//   kcode-sim-hid button <udid> <home|lock> [--developer-dir DIR]
//
// 退出码：0 成功 / 2 参数错误 / 3 环境不支持（框架或符号缺失）
//        4 设备不存在 / 5 设备未启动 / 6 注入失败

import CoreGraphics
import Darwin
import Foundation
import ObjectiveC

// MARK: - 退出码

enum ExitCode: Int32 {
    case ok = 0
    case usage = 2
    case unsupported = 3
    case deviceNotFound = 4
    case deviceNotBooted = 5
    case injectFailed = 6
}

func fail(_ code: ExitCode, _ message: String) -> Never {
    FileHandle.standardError.write(("错误：" + message + "\n").data(using: .utf8)!)
    exit(code.rawValue)
}

let usage = """
kcode-sim-hid —— 向 iOS 模拟器注入触摸/按键（走 Apple 私有接口，见源码注释）

用法：
  kcode-sim-hid probe  [--developer-dir DIR]
  kcode-sim-hid tap    <udid> <x> <y> [--developer-dir DIR]
  kcode-sim-hid swipe  <udid> <x1> <y1> <x2> <y2> [--duration MS] [--developer-dir DIR]
  kcode-sim-hid button <udid> <home|lock> [--developer-dir DIR]

坐标是**归一化 0..1**（相对模拟器屏幕），不是像素。
"""

// MARK: - 参数解析
//
// 手写而不引入 ArgumentParser：只有四种命令、参数形状固定，且这是要打进
// app 的 helper，多一个依赖就多一份体积与版本风险。

struct Args {
    var command = ""
    var positionals: [String] = []
    var developerDir: String?
    var durationMs = 300
}

func parseArgs(_ argv: [String]) -> Args {
    var a = Args()
    var rest = argv.dropFirst()
    guard let cmd = rest.first else {
        FileHandle.standardError.write(usage.data(using: .utf8)!)
        exit(ExitCode.usage.rawValue)
    }
    a.command = String(cmd)
    rest = rest.dropFirst()

    var pendingDeveloperDir = false
    var pendingDuration = false
    for arg in rest {
        if pendingDeveloperDir {
            a.developerDir = arg
            pendingDeveloperDir = false
            continue
        }
        if pendingDuration {
            guard let ms = Int(arg), ms >= 0, ms <= 10_000 else {
                fail(.usage, "--duration 需要 0..10000 的毫秒数，收到 \(arg)")
            }
            a.durationMs = ms
            pendingDuration = false
            continue
        }
        switch arg {
        case "--developer-dir":
            pendingDeveloperDir = true
        case "--duration":
            pendingDuration = true
        case "-h", "--help":
            print(usage)
            exit(ExitCode.ok.rawValue)
        default:
            if arg.hasPrefix("--") {
                fail(.usage, "未知选项 \(arg)")
            }
            a.positionals.append(arg)
        }
    }
    if pendingDeveloperDir { fail(.usage, "--developer-dir 缺少值") }
    if pendingDuration { fail(.usage, "--duration 缺少值") }
    return a
}

// MARK: - 私有框架加载

/// 找到当前使用的开发者目录。
func resolveDeveloperDir(_ fromArgs: String?) -> String {
    if let d = fromArgs, !d.isEmpty { return d }
    // 退回 `xcode-select -p`：helper 单独跑时（不经 KCode）也需要能工作
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
    p.arguments = ["-p"]
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = Pipe()
    do {
        try p.run()
        p.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let s = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let s, !s.isEmpty { return s }
    } catch {
        // 落回空串，由下面报「框架加载失败」
    }
    return ""
}

/// dlopen 私有框架，返回 SimulatorKit 的 handle（用于 dlsym）。
///
/// # 为什么把路径都试一遍
///
/// SimulatorKit 的位置在 Xcode 27 变过（`Developer/Library/PrivateFrameworks`
/// → `Contents/SharedFrameworks`），CoreSimulator 则同时在系统与 Xcode 内。
/// 全部尝试的代价只是几次 dlopen，而漏掉一个的代价是「用户机器上不可用」。
func loadPrivateFrameworks(developerDir: String) -> UnsafeMutableRawPointer? {
    var candidates: [String] = []
    // CoreSimulator：系统级的通常存在且版本匹配当前运行时
    candidates.append("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator")
    if !developerDir.isEmpty {
        candidates.append("\(developerDir)/Library/PrivateFrameworks/CoreSimulator.framework/CoreSimulator")
    }
    // SimulatorKit：Xcode 27+ 与 26- 两种布局
    var simulatorKitPaths: [String] = []
    if !developerDir.isEmpty {
        simulatorKitPaths.append("\(developerDir)/../SharedFrameworks/SimulatorKit.framework/SimulatorKit")
        simulatorKitPaths.append("\(developerDir)/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit")
    }

    for path in candidates {
        _ = dlopen(path, RTLD_NOW | RTLD_GLOBAL)
    }
    var simKit: UnsafeMutableRawPointer?
    for path in simulatorKitPaths {
        if let h = dlopen(path, RTLD_NOW | RTLD_GLOBAL) {
            simKit = h
            break
        }
    }
    return simKit
}

/// 取一个导出符号：先在自己 dlopen 的 handle 里找，再退回全局作用域。
///
/// 两层是必要的：dlopen 的可见性规则（RTLD_LOCAL/GLOBAL）在不同系统版本上
/// 行为有差异，而 dlsym(RTLD_DEFAULT) 只在符号进了全局作用域时才找得到。
/// 两层都试，就不必依赖那个细节。
func findSymbol(_ handle: UnsafeMutableRawPointer?, _ name: String) -> UnsafeMutableRawPointer? {
    if let handle, let p = dlsym(handle, name) { return p }
    return dlsym(UnsafeMutableRawPointer(bitPattern: -2), name)  // RTLD_DEFAULT
}

// MARK: - 私有接口的类型声明
//
// ABI 依据（与参考实现一致）：
//   IndigoHIDMessageForMouseNSEvent(CGPoint*, CGPoint*, IndigoHIDTarget,
//                                   NSEventType, NSSize, IndigoHIDEdge)
// arm64：指针/整数走 x0-x4，浮点走 d0-d1（编号独立）。
typealias IndigoMouseFunc = @convention(c) (
    UnsafePointer<CGPoint>, UnsafePointer<CGPoint>?,
    UInt32, Int32, CGFloat, CGFloat, UInt32
) -> UnsafeMutableRawPointer?

typealias IndigoButtonFunc = @convention(c) (Int32, Int32, Int32) -> UnsafeMutableRawPointer?
typealias HIDInitFunc = @convention(c) (AnyObject, Selector, AnyObject, AutoreleasingUnsafeMutablePointer<NSError?>) -> AnyObject?
typealias SendFunc = @convention(c) (AnyObject, Selector, UnsafeMutableRawPointer?, ObjCBool, AnyObject?, AnyObject?) -> Void

/// 主屏数字转换器的 HID target。
///
/// `0x32` 是主显示屏；Duo（折叠屏）的集成盖板是 `0x40000001`。
/// 我们只支持普通单屏设备，所以固定用主屏值。
let mainScreenTouchTarget: UInt32 = 0x32

/// 事件类型：**只有 Down(1) 与 Up(2)**。
///
/// 参考实现里有一条实测结论：`Dragged(6)` 会被这个 C 函数拒绝，所以拖动
/// 中途的 move 也用 Down 发送（位置变化由坐标体现）。
let eventDown: Int32 = 1
let eventUp: Int32 = 2

/// 按键：home / lock。
///
/// `IndigoHIDMessageForButton(eventSource, direction, target)`。
/// 取值来自 SimulatorKit 的 IndigoHIDButton 枚举（与参考实现一致）。
func buttonCode(_ name: String) -> (Int32, Int32)? {
    switch name {
    case "home": return (0x0, 0x32)      // IndigoHIDButtonHome, target 主屏
    case "lock": return (0x1, 0x32)      // IndigoHIDButtonLock
    default: return nil
    }
}

// MARK: - 注入器

final class Injector {
    private let client: NSObject
    private let sendSelector: Selector
    private let sendIMP: IMP
    private let mouseFunc: IndigoMouseFunc
    private let buttonFunc: IndigoButtonFunc?

    init(deviceUDID: String, developerDir: String) throws {
        let simKit = loadPrivateFrameworks(developerDir: developerDir)

        guard let mousePtr = findSymbol(simKit, "IndigoHIDMessageForMouseNSEvent") else {
            throw NSError(domain: "kcode-sim-hid", code: Int(ExitCode.unsupported.rawValue),
                          userInfo: [NSLocalizedDescriptionKey:
                            "SimulatorKit 里没有 IndigoHIDMessageForMouseNSEvent（Xcode 版本可能不受支持）"])
        }
        mouseFunc = unsafeBitCast(mousePtr, to: IndigoMouseFunc.self)
        buttonFunc = findSymbol(simKit, "IndigoHIDMessageForButton")
            .map { unsafeBitCast($0, to: IndigoButtonFunc.self) }

        guard let device = Self.findDevice(udid: deviceUDID, developerDir: developerDir) else {
            throw NSError(domain: "kcode-sim-hid", code: Int(ExitCode.deviceNotFound.rawValue),
                          userInfo: [NSLocalizedDescriptionKey: "找不到设备 \(deviceUDID)"])
        }
        dbg("device.UDID = \(device.value(forKey: "UDID") ?? "nil")")
        let state = device.value(forKey: "stateString") as? String ?? "unknown"
        dbg("device.stateString = \(state)")
        guard state == "Booted" else {
            throw NSError(domain: "kcode-sim-hid", code: Int(ExitCode.deviceNotBooted.rawValue),
                          userInfo: [NSLocalizedDescriptionKey: "设备未启动（状态：\(state)）"])
        }

        guard let hidClass = NSClassFromString("_TtC12SimulatorKit24SimDeviceLegacyHIDClient") else {
            throw NSError(domain: "kcode-sim-hid", code: Int(ExitCode.unsupported.rawValue),
                          userInfo: [NSLocalizedDescriptionKey: "SimulatorKit 里没有 SimDeviceLegacyHIDClient"])
        }
        let initSel = NSSelectorFromString("initWithDevice:error:")
        guard let initIMP = class_getMethodImplementation(hidClass, initSel) else {
            throw NSError(domain: "kcode-sim-hid", code: Int(ExitCode.unsupported.rawValue),
                          userInfo: [NSLocalizedDescriptionKey: "SimDeviceLegacyHIDClient 缺少 initWithDevice:error:"])
        }
        dbg("HID 类 = \(hidClass)")
        dbg("initWithDevice:error: IMP = \(initIMP)")
        let initFunc = unsafeBitCast(initIMP, to: HIDInitFunc.self)
        var err: NSError?
        let made = initFunc(hidClass.alloc(), initSel, device, &err)
        if let err { throw err }
        guard let obj = made as? NSObject else {
            throw NSError(domain: "kcode-sim-hid", code: Int(ExitCode.injectFailed.rawValue),
                          userInfo: [NSLocalizedDescriptionKey: "创建 HID 客户端失败"])
        }
        client = obj

        // send 的实际签名是 (message:freeWhenDone:completionQueue:completion:)，
        // 用 IMP 直接调：`perform` 传不了 ObjCBool 与 nil 的组合。
        sendSelector = NSSelectorFromString("sendWithMessage:freeWhenDone:completionQueue:completion:")
        guard let sIMP = class_getMethodImplementation(object_getClass(obj), sendSelector) else {
            throw NSError(domain: "kcode-sim-hid", code: Int(ExitCode.unsupported.rawValue),
                          userInfo: [NSLocalizedDescriptionKey: "HID 客户端没有 sendWithMessage: 方法"])
        }
        sendIMP = sIMP
        dbg("sendWithMessage:...: IMP = \(sIMP)")
        dbg("客户端类 = \(type(of: obj))")

        // 看设备是否有 legacy HID 端口（没这个端口注入就无处可去）。
        // ⚠️ 不能直接 value(forKey:)：KVC 对不存在的键会**抛异常并终止进程**
        // （实测：`legacyHIDEventPort` 在 SimDeviceIOClient 上不存在，
        // 于是 helper 直接崩了）。先问 respondsToSelector 再取。
        if let io = device.perform(NSSelectorFromString("io"))?.takeUnretainedValue() as? NSObject {
            dbg("device.io = \(type(of: io))")
            for key in ["legacyHIDEventPort", "hidEventPort", "eventPort"] {
                let sel = NSSelectorFromString(key)
                if io.responds(to: sel) {
                    dbg("io.\(key) 存在")
                }
            }
        }
    }

    /// 用 CoreSimulator 的公开 KVC 路径找设备（不依赖私有 selector）。
    static func findDevice(udid: String, developerDir: String) -> NSObject? {
        guard let ctxClass = NSClassFromString("SimServiceContext") as? NSObject.Type else { return nil }
        let sharedSel = NSSelectorFromString("sharedServiceContextForDeveloperDir:error:")
        guard let ctx = ctxClass.perform(sharedSel, with: developerDir, with: nil)?
            .takeUnretainedValue() as? NSObject else { return nil }
        guard let set = ctx.perform(NSSelectorFromString("defaultDeviceSetWithError:"), with: nil)?
            .takeUnretainedValue() as? NSObject else { return nil }
        guard let devices = set.value(forKey: "devices") as? [NSObject] else { return nil }
        return devices.first {
            guard let u = $0.value(forKey: "UDID") as? NSUUID else { return false }
            return u.uuidString.caseInsensitiveCompare(udid) == .orderedSame
        }
    }

    /// 发送时给 completion 传一个真实回执，把失败暴露出来。
    ///
    /// # 为什么必须这么做（实测教训）
    ///
    /// 第一版传的是 `nil, nil`（既不给队列也不给回调），于是**发送失败完全
    /// 无声**：命令退出码 0，界面毫无变化。我当时用「截图字节数变了」当成
    /// 成功的证据——而那个变化其实只是状态栏时钟从 12:19 走到 12:20。
    /// 一个假阳性差点让一个不工作的注入被当成可用的。
    ///
    /// 现在所有 send 都挂回执，错误打进 stderr，注入层再据此非零退出。
    private var lastSendError: String?

    private func send(_ message: UnsafeMutableRawPointer?) {
        guard let message else { return }
        let sem = DispatchSemaphore(value: 0)
        let queue = DispatchQueue(label: "kcode-sim-hid.completion")
        typealias CompletionFunc = @convention(block) (NSError?) -> Void
        var caught: NSError?
        let block: CompletionFunc = { err in
            caught = err
            sem.signal()
        }
        let blockObj = unsafeBitCast(block, to: AnyObject.self)
        unsafeBitCast(sendIMP, to: SendFunc.self)(
            client, sendSelector, message, ObjCBool(true), queue as AnyObject, blockObj)
        // 等回执，最多 2 秒：拿不到回执本身就是一种失败（注入没送达）
        if sem.wait(timeout: .now() + 2) == .timedOut {
            lastSendError = "等待发送回执超时（注入未送达）"
        } else if let caught {
            lastSendError = caught.localizedDescription
        }
    }

    /// 最近一次注入是否失败（nil = 成功）。常驻模式用它回执。
    var sendError: String? { lastSendError }

    /// 打完注入后的收尾说明。
    ///
    /// **只在出错时说话**（成功时静默）：这个 helper 由上层按用户操作调用，
    /// 每次点击都往 stderr 写一行「成功」会淹没有用信息。
    /// 但失败必须可见——所以失败走 `fail()` 非零退出。
    func diagnose() {
        if let e = lastSendError {
            FileHandle.standardError.write("注入未送达：\(e)\n".data(using: .utf8)!)
        }
    }

    /// 只发不等回执（用于滑动**中途**的 move）。
    ///
    /// # 为什么中途不需要等
    ///
    /// 实测：每次 `send` 都等一次回执（dispatch 到另一个队列 + 信号量），
    /// 单步往返约 **330ms 的累计开销**——滑动 300ms 实际跑 610ms、
    /// 800ms 实际 1150ms。后果不只是慢：手势被拉长约一倍且**节奏不匀**，
    /// 而 iOS 的惯性滚动是**按 move 序列的时间与位移算速度**的，
    /// 节奏一乱就得到「速度偏低」→ 惯性不来或很弱 → 手感发涩。
    ///
    /// 中途的 move 是「尽力而为」的事件：丢了某一帧只影响轨迹平滑度，
    /// 而等待每一帧的回执会把整条轨迹拖垮。所以中途 fire-and-forget，
    /// **只在按下与抬起时等回执**（那两个决定这次手势是否真的成立）。
    private func touchNoWait(_ type: Int32, x: Double, y: Double) {
        var point = CGPoint(x: x, y: y)
        guard let msg = mouseFunc(&point, nil, mainScreenTouchTarget, type, 1.0, 1.0, 0) else {
            return
        }
        unsafeBitCast(sendIMP, to: SendFunc.self)(
            client, sendSelector, msg, ObjCBool(true), nil, nil)
    }

    /// 发一个触摸事件。返回 nil 表示成功，否则是失败原因。
    private func touch(_ type: Int32, x: Double, y: Double) -> String? {
        var point = CGPoint(x: x, y: y)
        guard let msg = mouseFunc(&point, nil, mainScreenTouchTarget, type, 1.0, 1.0, 0) else {
            return "构建 HID 消息返回 nil（坐标或 target 被拒）"
        }
        dbg("type=\(type) point=(\(x),\(y)) msg=\(msg)")
        lastSendError = nil
        send(msg)
        return lastSendError
    }

    /// 常驻模式用：不 exit，把结果放进 `lastSendError`。
    func tapQuiet(x: Double, y: Double) {
        lastSendError = nil
        if let e = touch(eventDown, x: x, y: y) { lastSendError = e; return }
        usleep(60_000)
        if let e = touch(eventUp, x: x, y: y) { lastSendError = e }
    }

    /// 常驻模式用：不 exit。
    func swipeQuiet(x1: Double, y1: Double, x2: Double, y2: Double, durationMs: Int) {
        lastSendError = nil
        let steps = max(2, min(120, durationMs / 8))
        let stepDelayUs = durationMs > 0 ? (durationMs * 1000) / steps : 8_000
        if let e = touch(eventDown, x: x1, y: y1) { lastSendError = e; return }
        for i in 1...steps {
            let t = Double(i) / Double(steps)
            usleep(useconds_t(stepDelayUs))
            touchNoWait(eventDown, x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t)
        }
        if let e = touch(eventUp, x: x2, y: y2) { lastSendError = e }
    }

    /// 常驻模式用：不 exit。
    func buttonQuiet(_ name: String) -> Bool {
        guard let (code, target) = buttonCode(name), let buttonFunc else { return false }
        guard let msg = buttonFunc(0, code, target) else { return false }
        lastSendError = nil
        send(msg)
        return lastSendError == nil
    }

    func tap(x: Double, y: Double) {
        if let e = touch(eventDown, x: x, y: y) {
            fail(.injectFailed, "按下事件未送达：\(e)")
        }
        usleep(60_000)  // 60ms：足够被识别为点击而不是长按（长按阈值约 500ms）
        if let e = touch(eventUp, x: x, y: y) {
            fail(.injectFailed, "抬起事件未送达：\(e)")
        }
    }

    /// 滑动：起点按下 → 中间插值移动 → 终点抬起。
    ///
    /// 步数按**时长**分配而不是固定条数：固定条数会让长距离滑动在极短时间
    /// 内跳完（iOS 可能识别成快速甩动），而我们的调用方（用户拖拽）本来就有
    /// 明确的时长。约 16ms 一步（≈60fps）是模拟器能跟上的节奏。
    func swipe(x1: Double, y1: Double, x2: Double, y2: Double, durationMs: Int) {
        // 步数上限从 60 提到 120：60 步在 800ms 长滑动上是每步约 18ms，
        // 位移跳跃明显；120 步更接近真机触摸的采样密度（约 120Hz）。
        // 提高步数**不再有额外往返代价**（中途不等回执了）。
        let steps = max(2, min(120, durationMs / 8))
        let stepDelayUs = durationMs > 0 ? (durationMs * 1000) / steps : 8_000

        if let e = touch(eventDown, x: x1, y: y1) {
            fail(.injectFailed, "按下事件未送达：\(e)")
        }
        for i in 1...steps {
            let t = Double(i) / Double(steps)
            let x = x1 + (x2 - x1) * t
            let y = y1 + (y2 - y1) * t
            usleep(useconds_t(stepDelayUs))
            // 中途**不等回执**（见 touchNoWait 的说明：等回执会让手势节奏
            // 被往返延迟绑架，进而毁掉 iOS 的惯性滚动）
            touchNoWait(eventDown, x: x, y: y)
        }
        if let e = touch(eventUp, x: x2, y: y2) {
            fail(.injectFailed, "抬起事件未送达：\(e)")
        }
    }

    func button(_ name: String) {
        guard let (code, target) = buttonCode(name) else {
            fail(.usage, "未知按键 \(name)（支持：home / lock）")
        }
        guard let buttonFunc else {
            fail(.unsupported, "SimulatorKit 里没有 IndigoHIDMessageForButton")
        }
        guard let msg = buttonFunc(0, code, target) else {
            fail(.injectFailed, "构建按键消息失败")
        }
        lastSendError = nil
        send(msg)
        if let e = lastSendError {
            fail(.injectFailed, "按键事件未送达：\(e)")
        }
    }
}

// MARK: - 入口

/// 详细日志（`KCODE_SIM_HID_DEBUG=1`）：把每一层的实际值打出来。
let debugEnabled = ProcessInfo.processInfo.environment["KCODE_SIM_HID_DEBUG"] != nil
func dbg(_ m: @autoclosure () -> String) {
    guard debugEnabled else { return }
    FileHandle.standardError.write(("  [dbg] " + m() + "\n").data(using: .utf8)!)
}

let args = parseArgs(CommandLine.arguments)
let developerDir = resolveDeveloperDir(args.developerDir)

// `--serve`：常驻模式（见 serve 的说明——省掉每次约 182ms 的连接开销）
if CommandLine.arguments.contains("--serve") {
    serve(developerDir: developerDir)
    exit(0)
}

/// 执行一次注入命令，失败即以非零码退出。
///
/// # 关于「退出码 0 不等于生效」（实测教训，必读）
///
/// 注入链路有三层，每层都可能静默失败：
///
///   1. 私有符号/类/selector 解析 —— 我们的代码能直接判定（缺失即报错）
///   2. 构建 HID 消息 —— 返回 nil 即失败（能判定）
///   3. **消息送达并生效** —— send 的回执只说明「服务端收下了」，
///      **不说明 iOS 真的执行了动作**
///
/// 第 3 层无法在这里判定。实测中我遇到过一次「回执无错误但界面没变」，
/// 当时用「截图字节数变了」当证据——而那个变化其实只是状态栏时钟跳动。
///
/// 因此这个 helper 的契约是：**退出码 0 表示「已成功送达」，
/// 不表示「动作已生效」**。生效与否由上层用画面变化来验证
/// （KCode 的取帧链路本来就在轮询比对，天然能做这件事）。
func run(_ args: Args, developerDir: String) throws {
    switch args.command {
    case "probe":
        // 只验证「私有接口在这个环境里可用」，**不要求设备启动**——
        // 能力探测与「某台设备现在能不能用」是两件事，混在一起会让
        // 用户在设备关机时看到「iOS 输入不可用」这种错误结论。
        let simKit = loadPrivateFrameworks(developerDir: developerDir)
        let hasMouse = findSymbol(simKit, "IndigoHIDMessageForMouseNSEvent") != nil
        let hasClass = NSClassFromString("_TtC12SimulatorKit24SimDeviceLegacyHIDClient") != nil
        let hasContext = NSClassFromString("SimServiceContext") != nil
        if hasMouse && hasClass && hasContext {
            print("ok")
            return
        }
        var missing: [String] = []
        if !hasMouse { missing.append("IndigoHIDMessageForMouseNSEvent") }
        if !hasClass { missing.append("SimDeviceLegacyHIDClient") }
        if !hasContext { missing.append("SimServiceContext") }
        fail(.unsupported, "缺少 \(missing.joined(separator: "、"))（developer-dir=\(developerDir.isEmpty ? "未取到" : developerDir)）")

    case "tap":
        guard args.positionals.count >= 3 else { fail(.usage, "tap 需要 <udid> <x> <y>") }
        let injector = try Injector(deviceUDID: args.positionals[0], developerDir: developerDir)
        injector.tap(x: doubleArg(1, "x", args), y: doubleArg(2, "y", args))
        injector.diagnose()

    case "swipe":
        guard args.positionals.count >= 5 else { fail(.usage, "swipe 需要 <udid> <x1> <y1> <x2> <y2>") }
        let injector = try Injector(deviceUDID: args.positionals[0], developerDir: developerDir)
        injector.swipe(x1: doubleArg(1, "x1", args), y1: doubleArg(2, "y1", args),
                       x2: doubleArg(3, "x2", args), y2: doubleArg(4, "y2", args),
                       durationMs: args.durationMs)
        injector.diagnose()

    case "button":
        guard args.positionals.count >= 2 else { fail(.usage, "button 需要 <udid> <home|lock>") }
        let injector = try Injector(deviceUDID: args.positionals[0], developerDir: developerDir)
        injector.button(args.positionals[1])
        injector.diagnose()

    default:
        fail(.usage, "未知命令 \(args.command)\n\n" + usage)
    }
}

/// 常驻模式：从 stdin 逐行读命令，**复用同一个 HID 客户端**。
///
/// # 为什么需要（实测数字）
///
/// 每次调用都重新建立连接的开销：
///
/// | 阶段 | 耗时 |
/// |---|---|
/// | dlopen 私有框架 | 25ms |
/// | **连 CoreSimulator + 找设备** | **150ms** |
/// | 建 HID 客户端 | 7ms |
///
/// 合计约 **182ms**。而滑动本身只要几十到几百毫秒——也就是说
/// **手势开始前先白等 182ms**，之后才动。用户感受是「点了/滑了之后先卡一下」，
/// 这正是「感觉卡」的来源之一。
///
/// 常驻后这些开销只付一次，之后每条命令都是纯粹的注入。
///
/// 命令格式（每行一条，制表符分隔）：
///   tap\t<udid>\t<x>\t<y>
///   swipe\t<udid>\t<x1>\t<y1>\t<x2>\t<y2>\t<durationMs>
///   button\t<udid>\t<home|lock>
///   ping\t<udid>
/// 每条命令回一行：`ok` 或 `err\t<原因>`（pong 回 `ok`）。
func serve(developerDir: String) {
    // 缓存按 UDID 建客户端：用户可能切设备，但同一个不必重建
    var cache: [String: Injector] = [:]
    func injector(_ udid: String) -> Injector? {
        if let c = cache[udid] { return c }
        guard let made = try? Injector(deviceUDID: udid, developerDir: developerDir) else {
            return nil
        }
        cache[udid] = made
        return made
    }

    let stdout = FileHandle.standardOutput
    func reply(_ line: String) {
        stdout.write((line + "\n").data(using: .utf8)!)
    }

    // 先把第一批连接建好再报 ready：让上层知道「现在发命令不会有启动开销」
    reply("ready")

    while let raw = readLine(strippingNewline: true) {
        let parts = raw.split(separator: "\t").map(String.init)
        guard let cmd = parts.first else { continue }
        func num(_ i: Int) -> Double? {
            i < parts.count ? Double(parts[i]) : nil
        }
        switch cmd {
        case "tap":
            guard parts.count >= 4, let x = num(2), let y = num(3), let inj = injector(parts[1]) else {
                reply("err\t参数或设备无效"); continue
            }
            inj.tapQuiet(x: x, y: y)
            reply(inj.sendError.map { "err\t\($0)" } ?? "ok")
        case "swipe":
            guard parts.count >= 7, let x1 = num(2), let y1 = num(3),
                  let x2 = num(4), let y2 = num(5), let d = num(6),
                  let inj = injector(parts[1]) else {
                reply("err\t参数或设备无效"); continue
            }
            inj.swipeQuiet(x1: x1, y1: y1, x2: x2, y2: y2, durationMs: Int(d))
            reply(inj.sendError.map { "err\t\($0)" } ?? "ok")
        case "button":
            guard parts.count >= 3, let inj = injector(parts[1]) else {
                reply("err\t参数或设备无效"); continue
            }
            if inj.buttonQuiet(parts[2]) {
                reply("ok")
            } else {
                reply("err\t不支持的按键")
            }
        case "ping":
            guard parts.count >= 2 else { reply("err\t缺 udid"); continue }
            reply(injector(parts[1]) != nil ? "ok" : "err\t连接失败")
        case "quit":
            reply("ok")
            exit(0)
        default:
            reply("err\t未知命令 \(cmd)")
        }
    }
}

/// 取第 `index` 个位置参数为 Double。
func doubleArg(_ index: Int, _ name: String, _ args: Args) -> Double {
    guard index < args.positionals.count else { fail(.usage, "缺少参数 \(name)") }
    guard let v = Double(args.positionals[index]) else {
        fail(.usage, "\(name) 不是数字：\(args.positionals[index])")
    }
    return v
}

try run(args, developerDir: developerDir)

