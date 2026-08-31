//! 「在文件夹中显示」跨平台兜底实现（审计#21）。
//!
//! tauri-plugin-opener 的 `revealItemInDir` 在 Windows/macOS 可靠；但 Linux 上它走
//! FileManager1 D-Bus（选中文件），2.5.4 的 portal 兜底 `service`/`interface` 写反，
//! 且没有 Electron `showItemInFolder` 的 `xdg-open` 兜底。本模块补齐标准降级链
//! （freedesktop 惯例，不针对特定发行版/容器特判）：
//!   - Linux：`xdg-open` 打开父目录（默认文件管理器，不选中文件——Electron 同款兜底）；
//!   - Windows：`explorer.exe /select,`；macOS：`open -R`（与插件等价，双保险）。
//!
//! 一律返回中文可读消息，前端统一 toast，不静默。

use std::path::Path;
use std::process::Command;

/// 在系统文件管理器中定位文件。调用方应先尝试插件，失败后再进这里。
pub fn reveal_in_folder(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if !p.exists() {
        return Err(format!("文件不存在或已被删除：{path}"));
    }
    #[cfg(target_os = "linux")]
    {
        // 标准 Linux 兜底：xdg-open 父目录交给默认文件管理器（inode/directory）。
        let parent = parent_dir(p);
        if try_spawn("xdg-open", &[parent])? {
            return Ok(());
        }
        Err("无法打开文件管理器：缺少 xdg-open".to_string())
    }
    #[cfg(target_os = "windows")]
    {
        // explorer.exe /select,"path"：选中文件（等价 SHOpenFolderAndSelectItems，更稳定）。
        if try_spawn("explorer", &[format!("/select,{path}")])? {
            return Ok(());
        }
        Err("explorer 启动失败".to_string())
    }
    #[cfg(target_os = "macos")]
    {
        if try_spawn("open", &["-R".to_string(), path.to_string()])? {
            return Ok(());
        }
        Err("open 启动失败".to_string())
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        Err("当前平台不支持「在文件夹中显示」".to_string())
    }
}

/// spawn 一个外部程序。NotFound（未安装）返回 Ok(false) 走下一级兜底，
/// 其余启动错误返回 Err。进程启动即视为成功（explorer/xdg-open 异步退出，无法探测其内部结果）。
fn try_spawn(cmd: &str, args: &[String]) -> Result<bool, String> {
    match Command::new(cmd).args(args).spawn() {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("{cmd} 启动失败：{e}")),
    }
}

fn parent_dir(p: &Path) -> String {
    p.parent()
        .filter(|d| !d.as_os_str().is_empty())
        .unwrap_or(p)
        .to_string_lossy()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parent_dir_falls_back_to_self() {
        assert_eq!(parent_dir(Path::new("a/b.png")), "a");
        assert_eq!(parent_dir(Path::new("x.png")), "x.png");
    }

    #[test]
    fn reveal_missing_file_returns_readable_error() {
        let err = reveal_in_folder("/nonexistent/aivs-reveal-test-file.png").unwrap_err();
        assert!(err.contains("文件不存在"), "{err}");
    }
}
