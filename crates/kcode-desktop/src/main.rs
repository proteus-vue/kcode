// Windows 发布版不弹出控制台窗口；其余平台无副作用。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    kcode_desktop_lib::run();
}
