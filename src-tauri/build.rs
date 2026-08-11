fn main() {
    // Windows 窗口/任务栏图标由 tauri-build 编译期嵌入 exe（winres 读 icon.ico）。
    // tauri-build 仅在启用 codegen feature 时才 watch bundle.icon，此处显式声明，
    // 否则更换图标后 cargo 不会重编译（exe 保留旧图标）。
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/32x32.png");
    println!("cargo:rerun-if-changed=icons/128x128.png");
    tauri_build::build()
}
