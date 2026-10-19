// Windows/macOS/Linux 桌面入口。
// 真正的逻辑在 lib.rs，这里只是把它拉起来——这样移动端可以复用同一个 lib。

// 发布构建时不要额外弹控制台窗口（默认就是 GUI 子系统，这行是显式声明意图）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    xiaomo_ai_lib::run()
}
