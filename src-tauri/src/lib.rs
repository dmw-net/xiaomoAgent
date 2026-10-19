// 小茉 AI 的桌面/移动外壳。
//
// 它做的事很少，但每一件都必须做对：
//   1. 启动 Node sidecar（后端服务）；
//   2. 读 sidecar 写的端口握手文件，拿到真实端口；
//   3. 把 WebView 指到那个地址；
//   4. 退出时确保 sidecar 一起死掉（否则用户关了窗口，任务管理器里还挂着一个 node.exe）。
//
// 两个设计取舍值得说明：
//
// 【为什么不用固定端口】Node 起服务是异步的，端口要到 listen 回调里才知道。
//   如果两边约定死 8787，用户机器上被别的程序占了就是白屏，而且报错毫无线索。
//   这里让 Node 把真实端口写进文件，外壳读文件——天然支持"端口被占就换一个"。
//
// 【为什么用 channel 而不是直接 navigate】WebviewWindow 不是 Send，
//   在子线程里调它的方法编译不过。所以子线程只负责启动和等待，
//   结果通过 std::sync::mpsc 发回主线程，由主线程导航。
//
// 【⚠️ 桌面与移动的根本差异】Tauri 的 sidecar（externalBin）**不支持移动端**：
//   二进制根本不会被打进 APK，而且 Android 10+ 禁止从应用数据目录执行文件。
//   所以这里用 cfg 分成两条路：
//     - desktop：本地 Node 后端（原方案，真的能离线跑）
//     - mobile ：连远程后端（本地跑不了 Node，只能连服务器）
//   这不是偷懒，是平台限制。

use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use std::time::Duration;

#[cfg(desktop)]
use std::path::PathBuf;
#[cfg(desktop)]
use std::time::Instant;

use tauri::{Manager, RunEvent, WindowEvent, WebviewUrl, WebviewWindowBuilder};

/// 保存 sidecar 句柄，退出时用它杀子进程。
/// 只有桌面端有 sidecar，移动端这个字段永远是 None。
struct SidecarState(Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

/// 托盘常驻开关的当前值（用户在「设置 → 界面 → 开机与关窗」里自己决定）。
/// 这一个值同时决定两件事：**托盘图标在不在**，以及点 × 是隐藏窗口还是真退出。
/// 两者必须一起——没有图标却把窗口藏起来，用户就再也找不回这个程序了。
/// 后端改它时通过 stdout 的 `XIAOMO-PREF` 标记实时送达外壳，不用重启
/// （见 src/desktop-prefs.ts 的注释）。
#[cfg(desktop)]
struct TrayState(Mutex<bool>);

/// 托盘图标的固定 id：拆建都按它找，避免一次标记写两遍后叠出两个图标。
#[cfg(desktop)]
const TRAY_ID: &str = "xiaomo-tray";

/// 子线程向主线程汇报的启动结果。
enum BootOutcome {
    Ready(String),
    Failed(String),
}

/// 握手超时：后端起不来时不能无限等，要给用户一个明确的错误。
#[cfg(desktop)]
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);

/// 轮询间隔：够快（用户几乎无感）又不至于把 CPU 打满。
#[cfg(desktop)]
const HANDSHAKE_POLL: Duration = Duration::from_millis(120);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default().manage(SidecarState(Mutex::new(None)));
    // 关窗留托盘的当前值；真正的值在 start_sidecar 读 desktop.json 时覆盖。
    // 移动端没有托盘，这个状态也就不存在（TrayState 本身是 cfg(desktop) 的）。
    #[cfg(desktop)]
    {
        // 缺省值必须和后端 src/desktop-prefs.ts 的 DEFAULTS 一致（用户拍的是默认关）：
        // 两边不一致时，第一次启动会「界面显示关闭、托盘却已经建起来」。
        builder = builder.manage(TrayState(Mutex::new(false)));
    }

    // shell 插件只在桌面端有意义（移动端没法跑 sidecar）。
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_shell::init());
        // 开机自动启动：只由 start_sidecar 按 desktop.json 里的 AUTOSTART 应用，
        // 这里 init() 只是把能力挂上（不 init 就拿不到 autolaunch()）。
        builder = builder.plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ));
        // 第二次点图标：不再叠一个后端进程，把已有窗口唤回前台。
        // 要 unhide：窗口可能是被"关窗留托盘"藏起来的，那时它根本没被销毁。
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }));
    }

    // opener：WebView 里 target=_blank 不会开新窗口，外链得交给系统浏览器。
    // 桌面和移动都要（「关于」里的开发者与 Issue 链接两端都有）。
    builder = builder.plugin(tauri_plugin_opener::init());

    // dialog：设置里选数据存储目录要原生文件夹选择器。
    builder = builder.plugin(tauri_plugin_dialog::init());
    // 通知：桌面和移动都要；浏览器开发环境会走 Web Notification 回退。
    builder = builder.plugin(tauri_plugin_notification::init());
    // process：改完数据目录后一键重启应用（仅桌面端，移动端没有"重启"语义）。
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_process::init());
        // updater：应用内检查更新。校验用的是 minisign 公钥（烧进包里），
        // 与 Authenticode 代码签名无关，所以不买证书也能有"这个包没被换过"的保证。
        // 注意界面此时跑在 http://127.0.0.1:端口 上，那是**远程 origin**，
        // 权限必须落在 capabilities/webview-remote.json，加在 default.json 里点了没反应。
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .setup(|app| {
            let handle = app.handle().clone();

            // 先把窗口开出来（显示一个加载页），再去拉后端。
            // 反过来的话，用户点图标后会有几秒钟"什么都没发生"。
            let mut builder_window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App("loading.html".into()),
            )
            .title("小茉")
            // 桌面默认开到桌面布局尺寸（三栏需 ≥760px 宽，低于就走手机断点）。
            // min 宽度 780 > 断点 760：用户把窗口拉到最小也不会意外切成手机布局。
            // 移动端 Tauri 忽略 inner_size（全屏），此配置不影响 Android。
            .inner_size(1180.0, 800.0)
            .min_inner_size(780.0, 560.0)
            .resizable(true);

            // 上次的位置/尺寸（自己存的，见 save_window_state 的说明）：
            // 存过的值必须过一道屏幕范围校验才敢用，否则拔掉外接屏后窗口会开在看不见的地方。
            #[cfg(desktop)]
            let saved = load_window_state(&handle);
            #[cfg(desktop)]
            if let Some(state) = saved.as_ref().filter(|s| !s.maximized) {
                builder_window = builder_window
                    .inner_size(state.width.max(780.0), state.height.max(560.0))
                    .position(state.x, state.y);
            }
            let window = builder_window.build()?;
            #[cfg(desktop)]
            if saved.as_ref().is_some_and(|s| s.maximized) {
                let _ = window.maximize();
            }

            // 托盘**不在这里建**：托盘常驻是用户在设置里自己决定的开关，
            // 由 start_sidecar 读到 desktop.json 的 TRAY 之后按值建/拆（见 apply_desktop_prefs）。

            let (tx, rx) = mpsc::channel::<BootOutcome>();

            // 子线程：启动后端并等它报到。
            // 桌面走 sidecar，移动端走远程地址——两条路，同一个 channel 出口。
            let boot_handle = handle.clone();
            std::thread::spawn(move || {
                if let Err(message) = start_backend(&boot_handle, tx.clone()) {
                    let _ = tx.send(BootOutcome::Failed(message));
                }
            });

            // 用异步任务接收结果，**不能**在 setup 里阻塞等待。
            // setup 运行在主线程上，一旦阻塞，刚建好的窗口会直接卡死（连加载动画都不转）。
            tauri::async_runtime::spawn(async move {
                // 放到阻塞线程池里 recv，避免占住 async 运行时的工作线程。
                let outcome = tauri::async_runtime::spawn_blocking(move || {
                    let timeout = boot_timeout();
                    rx.recv_timeout(timeout + Duration::from_secs(5))
                        .unwrap_or_else(|_| {
                            BootOutcome::Failed(
                                "后端启动超时，没有收到任何状态回报。".to_string(),
                            )
                        })
                })
                .await
                .unwrap_or_else(|_| BootOutcome::Failed("等待后端时内部错误。".to_string()));

                match outcome {
                    BootOutcome::Ready(url) => {
                        // 用 navigate 而不是重建窗口，这样窗口尺寸/位置不会跳。
                        if let Ok(parsed) = url.parse() {
                            let _ = window.navigate(parsed);
                        }
                    }
                    BootOutcome::Failed(message) => {
                        // 起不来就明确告诉用户，而不是留一个永远转圈的白屏。
                        let html = error_page(&message);
                        let data_url =
                            format!("data:text/html;charset=utf-8,{}", urlencode(&html));
                        if let Ok(parsed) = data_url.parse() {
                            let _ = window.navigate(parsed);
                        }
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("构建 Tauri 应用失败")
        .run(|app, event| {
            #[cfg(desktop)]
            {
                // 记住窗口位置/尺寸（自己存 window.json，见下方注释）：拖动与缩放时
                // 限频 1 秒写一次，关窗那一刻必写一次。
                if let RunEvent::WindowEvent { label, event, .. } = &event {
                    if label == "main" {
                        match event {
                            WindowEvent::Resized(_) | WindowEvent::Moved(_) => save_window_state_throttled(app),
                            WindowEvent::CloseRequested { api, .. } => {
                                save_window_state(app);
                                // 留在托盘：关窗只是藏起来，后端继续跑（主动性任务、微信/QQ
                                // 长轮询都在 sidecar 进程里，窗口关了它们就没了 = 她"下线"）。
                                if tray_enabled(app) {
                                    api.prevent_close();
                                    if let Some(window) = app.get_webview_window("main") {
                                        let _ = window.hide();
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
            // 退出时杀掉 sidecar。这是最后一道保险；Node 侧还有 stdin-EOF 兜底。
            if let RunEvent::Exit = event {
                #[cfg(desktop)]
                save_window_state(app);
                if let Some(state) = app.try_state::<SidecarState>() {
                    if let Some(child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}

/// 等待后端报到的超时时间。移动端没有 sidecar 启动开销，可以短一点。
fn boot_timeout() -> Duration {
    #[cfg(desktop)]
    {
        HANDSHAKE_TIMEOUT
    }
    #[cfg(mobile)]
    {
        Duration::from_secs(15)
    }
}

/// 启动后端。桌面端起本地 Node；移动端连远程服务。
fn start_backend(app: &tauri::AppHandle, tx: Sender<BootOutcome>) -> Result<(), String> {
    #[cfg(desktop)]
    {
        start_sidecar(app, tx)
    }
    #[cfg(mobile)]
    {
        start_remote_backend(app, tx)
    }
}

/// 移动端：Tauri 的 sidecar 不支持 Android，本地跑不了 Node。
///
/// 所以这里改成连远程后端。地址按优先级从三个地方找：
///   1. 编译期注入的 `XIAOMO_REMOTE_BASE_URL`（构建时 `--config` 或环境变量）
///   2. 运行时的同名环境变量（调试用）
///   3. 应用数据目录下的 `remote.json`
/// 都没有就返回一条明确的说明，而不是让用户对着白屏猜。
#[cfg(mobile)]
fn start_remote_backend(app: &tauri::AppHandle, tx: Sender<BootOutcome>) -> Result<(), String> {
    // 1. 编译期常量。用 option_env! 是为了没设置时也能编译通过。
    const BUILT_IN: Option<&str> = option_env!("XIAOMO_REMOTE_BASE_URL");
    if let Some(url) = BUILT_IN {
        if !url.trim().is_empty() {
            let _ = tx.send(BootOutcome::Ready(url.to_string()));
            return Ok(());
        }
    }

    // 2. 运行时环境变量（调试时方便，不用重新编译）。
    if let Ok(url) = std::env::var("XIAOMO_REMOTE_BASE_URL") {
        if !url.trim().is_empty() {
            let _ = tx.send(BootOutcome::Ready(url));
            return Ok(());
        }
    }

    // 3. 数据目录下的配置文件。Android 上没有环境变量，这是实际会用到的路径。
    if let Ok(data_dir) = app.path().app_data_dir() {
        let file = data_dir.join("remote.json");
        if let Ok(raw) = std::fs::read_to_string(&file) {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(url) = parsed.get("baseUrl").and_then(|v| v.as_str()) {
                    if !url.trim().is_empty() {
                        let _ = tx.send(BootOutcome::Ready(url.to_string()));
                        return Ok(());
                    }
                }
            }
        }
    }

    let _ = tx.send(BootOutcome::Failed(
        "Android 版暂时需要连接服务端。\n\n\
         原因：Tauri 的内置进程（sidecar）在移动端不被支持，\n\
         Android 也无法在本机运行 Node 后端。\n\n\
         解决（任选一条）：\n\
         1. 构建前设置 XIAOMO_REMOTE_BASE_URL=https://你的域名\n\
         2. 在应用数据目录放一个 remote.json：\n\
            { \"baseUrl\": \"https://你的域名\" }\n\n\
         桌面版不受影响，可以完全离线使用。"
            .to_string(),
    ));
    Ok(())
}

/// 探针目录是否真可写：create_dir_all 成功还不够（Program Files 下可能建了却只读）。
#[cfg(desktop)]
fn writable_dir(dir: &std::path::Path) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".write-test");
    match std::fs::write(&probe, b"ok") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// 默认数据目录：安装目录的**同级** `xiaomodata`（好找、卸载不丢——卸载器只删安装目录本身，
/// 不动同级目录）；不可写（如装到 Program Files）则回退锚点。
#[cfg(desktop)]
fn default_data_dir(anchor: &std::path::Path) -> std::path::PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(install) = exe.parent() {
            if let Some(sibling_parent) = install.parent() {
                let candidate = sibling_parent.join("xiaomodata");
                if writable_dir(&candidate) {
                    return candidate;
                }
            }
        }
    }
    anchor.to_path_buf()
}

/// 决定数据目录：沿用 desktop.json 里已有的 DATA_DIR（用户在设置里改过的）；没有才算默认。
#[cfg(desktop)]
fn resolve_data_dir(config_file: &std::path::Path, anchor: &std::path::Path) -> std::path::PathBuf {
    if let Ok(raw) = std::fs::read_to_string(config_file) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(s) = v.get("DATA_DIR").and_then(|x| x.as_str()) {
                if !s.is_empty() {
                    let p = std::path::PathBuf::from(s);
                    let _ = std::fs::create_dir_all(&p);
                    return p;
                }
            }
        }
    }
    default_data_dir(anchor)
}

// 资源完整性校验用的 minisign 公钥（base64 包着公钥文件内容，与 Tauri 的约定一致）。
//
// **别在这里手抄**：值由 `build.rs` 从 `tauri.conf.json` 的 `plugins.updater.pubkey`
// 原样生成，与 updater 用的是同一处来源——换发版密钥只改 conf，这里自动跟上。
// 抄一份的代价 2026-10-17 实测过：那时这里的 `untrusted comment` 行写着 `…4E76`、
// 真 keyID 是 `E664C16445FA4E7F`。验签没事（minisign 只读第 2 行），但人拿两行一对
// 就会以为"换过钥匙、已发的包要砖"。
#[cfg(desktop)]
const RESOURCE_PUBKEY_B64: &str = env!("XIAOMO_RESOURCE_PUBKEY_B64");

/// 资源完整性校验：确认安装包里的后端/前端资源没被换过。
///
/// 清单 `backend/manifest.json` 由发版私钥签名，公钥烧在本二进制里；验签通过后
/// 再逐文件比对 sha256。失败一律返回 Err，由调用方转成 `BootOutcome::Failed`
/// 走现有错误页——**不要在这里弹窗或 exit**：那时窗口已经建好，直接展示更清楚，
/// 而 exit 只会让用户看到"图标转一下就没了"。
///
/// 边界（别当铁门）：挡的是「不会逆向的人改包重分发」——他们签不出新的 manifest。
/// 挡不住会逆向的人 patch 掉本函数或换掉 `RESOURCE_PUBKEY_B64`：本地 exe 上
/// 没有任何手段能防后者。
#[cfg(desktop)]
fn verify_resources(app: &tauri::AppHandle) -> Result<(), String> {
    use base64::Engine as _;
    use sha2::{Digest, Sha256};

    // 开发构建跳过：tauri dev 用的是 `make-manifest --unsigned` 生成的未签名清单。
    // cfg! 是编译期常量，release 里这段会被优化掉，不会留下运行时分支。
    if cfg!(debug_assertions) {
        return Ok(());
    }

    // 逃生口（2026-10-19）：硬失败会误伤正常用户——杀软隔离/清理工具删掉 manifest、
    // 或用户手动动过安装目录里的文件，应用就直接打不开且没有任何自愈路径。
    // 约定：在 %APPDATA%\app.xiaomo.ai 下建一个名为 allow-unsigned 的空文件，
    // 本次启动跳过校验（每次启动都会重新检查，删掉标记立即恢复严格模式）。
    // 安全边界：这个标记在用户的 AppData 里，改包分发者无法随安装包预置；
    // 它救的是"自己机器上被误删"的场景，不是给盗版开的门。
    if let Ok(anchor) = app.path().app_data_dir() {
        if anchor.join("allow-unsigned").exists() {
            println!("[verify] 检测到 allow-unsigned 标记：本次启动跳过资源完整性校验（不推荐长期保留）");
            return Ok(());
        }
    }

    let res = app
        .path()
        .resource_dir()
        .map_err(|e| format!("找不到资源目录：{e}"))?;

    let manifest = std::fs::read_to_string(res.join("backend").join("manifest.json"))
        .map_err(|_| "安装文件清单缺失：安装包可能不完整，请重新安装".to_string())?;
    let json: serde_json::Value =
        serde_json::from_str(&manifest).map_err(|e| format!("安装文件清单损坏：{e}"))?;

    if json.get("signed").and_then(|v| v.as_bool()) != Some(true) {
        return Err("安装文件清单未签名：这不是官方发布的安装包".to_string());
    }

    // `.sig` 是 base64 包着的 minisign 签名（`tauri signer sign` 的产物就是这个格式），
    // 处理方式与 tauri-plugin-updater 校验更新包时一致：先 base64 解，再 Signature::decode。
    let sig_b64 = std::fs::read_to_string(res.join("backend").join("manifest.json.sig"))
        .map_err(|_| "安装文件签名缺失：安装包可能不完整".to_string())?;
    let sig_text = String::from_utf8(
        base64::engine::general_purpose::STANDARD
            .decode(sig_b64.trim().as_bytes())
            .map_err(|_| "安装文件签名格式错误".to_string())?,
    )
    .map_err(|_| "安装文件签名格式错误".to_string())?;

    let pk_text = String::from_utf8(
        base64::engine::general_purpose::STANDARD
            .decode(RESOURCE_PUBKEY_B64.trim().as_bytes())
            .map_err(|_| "内置公钥解码失败".to_string())?,
    )
    .map_err(|_| "内置公钥解码失败".to_string())?;

    let pk =
        minisign_verify::PublicKey::decode(&pk_text).map_err(|e| format!("内置公钥无效：{e}"))?;
    let sig =
        minisign_verify::Signature::decode(&sig_text).map_err(|e| format!("签名解析失败：{e}"))?;
    // allow_legacy = true：与 tauri-plugin-updater 的调用保持一致（updater.rs 里也是 true）。
    pk.verify(manifest.as_bytes(), &sig, true)
        .map_err(|_| "安装文件签名不匹配：安装包已被修改".to_string())?;

    let files = json
        .get("files")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "安装文件清单缺少 files 字段".to_string())?;
    for (rel, want) in files {
        let want = want
            .as_str()
            .ok_or_else(|| "安装文件清单格式错误".to_string())?;
        let bytes = std::fs::read(res.join(rel)).map_err(|_| format!("安装文件缺失：{rel}"))?;
        let got = format!("{:x}", Sha256::digest(&bytes));
        if got != want {
            return Err(format!("安装文件被修改：{rel}"));
        }
    }

    // 反向校验：安装目录里 backend/ 下的每个文件都必须在清单里。
    // 只验「清单 → 磁盘」的话，升级残留或塞进来的多文件是查不到的——
    // 2026-10-19 实测覆盖安装会把上一版的前端 chunk 原样留下（134 个文件、
    // 清单只认 24 个），那些残留不在签名保护范围内。
    // 清单自身两项是例外：manifest 不能包含自己的签名，和构建期 verify-staged.mjs 同一套口径。
    let mut found = 0usize;
    let mut queue = vec![res.join("backend")];
    while let Some(dir) = queue.pop() {
        for entry in std::fs::read_dir(&dir).map_err(|e| format!("读安装目录失败：{e}"))? {
            let entry = entry.map_err(|e| format!("读安装目录失败：{e}"))?;
            let path = entry.path();
            if path.is_dir() {
                queue.push(path);
                continue;
            }
            let rel = path
                .strip_prefix(&res)
                .map_err(|_| "安装目录布局异常".to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            if rel.ends_with("manifest.json") || rel.ends_with("manifest.json.sig") {
                continue;
            }
            if !files.contains_key(&rel) {
                return Err(format!(
                    "发现清单之外的文件：{rel}\n安装目录与官方清单不一致，请重新安装"
                ));
            }
            found += 1;
        }
    }
    let listed = files.len();
    if found != listed {
        return Err(format!(
            "安装文件不完整：清单 {listed} 项，磁盘只找到 {found} 项，请重新安装"
        ));
    }
    Ok(())
}

/// 还原 build.rs 混淆过的资产密钥：hex → XOR 0xA5 → base64 原文。
/// build.rs 那头是 `format!("{:02x}", byte ^ 0xA5)`，这里做精确的逆。
/// 常量由 build.rs 保证存在且配对，解错只可能发生在两边不同步（编译期就炸），运行期不校验。
#[cfg(desktop)]
fn deobfuscate_asset_key(hex_input: &str) -> String {
    fn hex_val(b: u8) -> Option<u8> {
        match b {
            b'0'..=b'9' => Some(b - b'0'),
            b'a'..=b'f' => Some(b - b'a' + 10),
            b'A'..=b'F' => Some(b - b'A' + 10),
            _ => None,
        }
    }
    let bytes = hex_input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    let mut i = 0;
    while i + 1 < bytes.len() {
        let (hi, lo) = match (hex_val(bytes[i]), hex_val(bytes[i + 1])) {
            (Some(h), Some(l)) => (h, l),
            _ => return String::new(), // 形态坏了就给空串，让 sidecar 的 fail-fast 接手
        };
        out.push(((hi << 4) | lo) ^ 0xA5);
        i += 2;
    }
    String::from_utf8(out).unwrap_or_default()
}

/// 桌面端：启动 Node sidecar 并等握手。成功后把句柄存进 state、把 URL 发给主线程。
#[cfg(desktop)]
fn start_sidecar(app: &tauri::AppHandle, tx: Sender<BootOutcome>) -> Result<(), String> {
    use tauri_plugin_shell::process::CommandEvent;
    use tauri_plugin_shell::ShellExt;

    // 第一件事：验资源。放在 sidecar 之前——被换掉的后端不该有机会执行。
    verify_resources(app)?;

    // 锚点目录：始终可写、稳定，放 desktop.json / runtime.json / backend.log。
    // 与「数据目录」解耦——数据目录用户可改，但锚点不能丢（否则改完位置下次启动找不到配置）。
    let anchor = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("找不到应用数据目录：{e}"))?;
    std::fs::create_dir_all(&anchor).map_err(|e| format!("创建数据目录失败：{e}"))?;

    let runtime_file = anchor.join("runtime.json");
    // 上次异常退出可能留下过期文件，先删。
    // 不删的话我们会立刻读到"上一次的端口"，然后连到一个根本不存在的服务。
    let _ = std::fs::remove_file(&runtime_file);

    // 配置文件：交给 Node 的 desktop.ts 读，一个真源。
    let config_file = anchor.join("desktop.json");
    // 数据目录：优先沿用上次写进 desktop.json 的 DATA_DIR（用户在设置里改过的）；
    // 没有才算默认——安装目录的同级 `xiaomodata`（好找、卸载不丢：卸载器只删安装目录本身，
    // 不动同级目录）。可写检测，不可写（如装到 Program Files）回退锚点。
    let data_dir = resolve_data_dir(&config_file, &anchor);
    // 外壳每次启动都要重写的几项（端口/数据目录/心跳文件…）。
    // ⚠️ 刻意**合并**而不是整份覆盖：desktop.json 里还有 AUTOSTART / TRAY 两项是用户在
    // 设置里设的，早期这里是直接 write 覆盖——那等于每次重启都把用户的自启开关抹掉，
    // 而且抹得毫无痕迹（文件看着还在，值没了）。
    let mut config_json = match std::fs::read_to_string(&config_file)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
    {
        Some(serde_json::Value::Object(map)) => serde_json::Value::Object(map),
        _ => serde_json::json!({}),
    };
    {
        let obj = config_json
            .as_object_mut()
            .ok_or_else(|| "配置文件里的配置不是对象".to_string())?;
        for (key, value) in serde_json::json!({
            "PORT": "0",
            "DATA_DIR": data_dir.to_string_lossy(),
            "RUNTIME_FILE": runtime_file.to_string_lossy(),
            "DB_PATH": "xiaomo.db",
            // echo 模式开箱即用；用户后续在应用内配置模型。
            "MODEL_MODE": "echo",
            "PROACTIVE_ENABLED": "true",
            "PROACTIVE_INTERVAL_MINUTES": "30",
            "PROACTIVE_IDLE_MINUTES": "120",
            "QUIET_HOURS": "23-8",
            "CHARACTER_NAME": "小茉",
            "MODEL_STARTUP_CHECK": "false"
        })
        .as_object()
        .expect("上面这个字面量就是对象")
        {
            obj.insert(key.clone(), value.clone());
        }

        // 排障面（状态页的「调用记录 / 最近处理 / 记忆测试」）只在开发构建里打开。
        // 用编译期门而不是运行期判断：release 包里这段代码根本不存在，
        // 所以发布版无论 desktop.json 写了什么都不会有这几个 tab——不可能漏关。
        // 开发构建会覆盖配置里手写的值（想要关掉就临时改这里，而不是改 JSON）。
        #[cfg(debug_assertions)]
        {
            obj.insert("DEV_MODE".into(), serde_json::Value::String("1".into()));
        }
    }
    std::fs::write(&config_file, config_json.to_string())
        .map_err(|e| format!("写配置失败：{e}"))?;

    // 卸载器要知道数据目录在哪。它读不了 JSON（NSIS 里解析转义路径是自己找雷），
    // 所以这里另写一行纯文本指针；改数据目录的后端路径（src/data-dir.ts）写同一个文件。
    // 卸载器拿到之后还要过护栏（必须存在、必须有 xiaomo.db），指针过期只会"拒绝删除并说明"，
    // 不会删错地方。
    let _ = std::fs::write(
        anchor.join("data-dir.txt"),
        format!("{}\n", data_dir.to_string_lossy()),
    );

    // 把存着的偏好落到系统上（登录项 / 关窗行为）。第一次启动没有这两项 → 按缺省。
    let (autostart, tray) = prefs_from_json(&config_json);
    apply_desktop_prefs(app, autostart, tray);

    let script = resource_script_path(app)?;

    // 通过 sidecar 机制调起打包进来的 node。
    //
    // ⚠️ 路径必须转成正斜杠再传，否则 Windows 的反斜杠会被命令行解析当成转义符吃掉：
    //    `D:\z\...` → Node 收到 `D:z...` → 报 `EISDIR: lstat 'D:'`。
    //    Windows API 本身就接受正斜杠，所以这是无损且最省事的做法。
    let script_arg = to_forward_slashes(&script);
    let config_arg = to_forward_slashes(&config_file);

    let sidecar = app
        .shell()
        .sidecar("node-sidecar")
        .map_err(|e| format!("找不到内置 node：{e}"))?
        .args([
            "--experimental-sqlite".to_string(),
            script_arg,
            "--config".to_string(),
            config_arg,
        ])
        // 资产解码密钥：server.mjs 里的中文载荷是 base64(XOR(·, key))，
        // 密钥只存在于这个环境变量里——它不落在安装目录任何文件上。
        // build.rs 里存的是 XOR 0xA5 + hex 的混淆形态（防 strings 直捞），
        // 这里还原成原文再交给 sidecar。
        // dev 构建跑的是 TS 源码（中文明文），这个变量对它无意义，传了也无妨。
        .env("XM_ASSET_KEY", deobfuscate_asset_key(env!("XIAOMO_ASSET_KEY_OBF")));

    let (mut rx, child) = sidecar.spawn().map_err(|e| format!("启动后端失败：{e}"))?;

    // 把 sidecar 的输出落到 backend.log（每次启动重写）。GUI 模式下 println 用户看不到，
    // 而「后端 30 秒没启动」这类失败若没有任何线索，用户只能对着弹窗猜。
    // 失败必须可见——这条日志是桌面端排障的唯一入口。
    let log_path = anchor.join("backend.log");
    let log = std::fs::File::create(&log_path).ok();
    let marker_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        use std::io::Write;
        let mut log = log;
        while let Some(event) = rx.recv().await {
            let line = match event {
                CommandEvent::Stdout(line) => String::from_utf8_lossy(&line).trim_end().to_string(),
                CommandEvent::Stderr(line) => String::from_utf8_lossy(&line).trim_end().to_string(),
                CommandEvent::Terminated(_) => "（sidecar 进程已退出）".to_string(),
                CommandEvent::Error(e) => format!("（sidecar 错误：{e}）"),
                _ => continue,
            };
            // 后端在设置里改这两项开关时会打一行 `XIAOMO-PREF {json}`。走这条现成的通道
            // 是为了**不用重启就生效**：否则用户拨完开关要重启才看到变化，就是"点了没反应"。
            // 标记照常也写进 backend.log——它是"这次点击真的送达外壳了"的唯一凭证。
            #[cfg(desktop)]
            if let Some(payload) = line.strip_prefix("XIAOMO-PREF ") {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) {
                    let autostart = value.get("autostart").and_then(|v| v.as_bool()).unwrap_or(false);
                    let tray = value.get("tray").and_then(|v| v.as_bool()).unwrap_or(true);
                    apply_desktop_prefs(&marker_handle, autostart, tray);
                }
                continue;
            }
            println!("[node] {line}");
            if let Some(f) = log.as_mut() {
                let _ = writeln!(f, "{line}");
                let _ = f.flush();
            }
        }
    });

    // 等握手文件出现。超时说明 sidecar 挂了或起得太慢。
    let deadline = Instant::now() + HANDSHAKE_TIMEOUT;
    loop {
        if Instant::now() > deadline {
            // kill 会消费 child，所以这里不能用它之后再存 state。
            let _ = child.kill();
            // 把 backend.log 的最后几行附在错误里——日志就在旁边，没有理由让人去翻文件。
            let tail = std::fs::read_to_string(&log_path)
                .map(|content| {
                    let lines: Vec<&str> = content.lines().collect();
                    let start = lines.len().saturating_sub(8);
                    lines[start..].join("\n")
                })
                .unwrap_or_default();
            let hint = if tail.trim().is_empty() {
                String::new()
            } else {
                format!("\n\n后端日志（最后几行）：\n{tail}")
            };
            return Err(format!(
                "后端在 {} 秒内没有启动完成。{}\n详细日志见：{}",
                HANDSHAKE_TIMEOUT.as_secs(),
                hint,
                log_path.to_string_lossy()
            ));
        }
        if let Ok(raw) = std::fs::read_to_string(&runtime_file) {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(url) = parsed.get("url").and_then(|v| v.as_str()) {
                    // 存句柄供退出时清理。
                    if let Some(state) = app.try_state::<SidecarState>() {
                        *state.0.lock().unwrap() = Some(child);
                    }
                    let _ = tx.send(BootOutcome::Ready(url.to_string()));
                    return Ok(());
                }
            }
        }
        std::thread::sleep(HANDSHAKE_POLL);
    }
}

/// sidecar 脚本在资源目录里的绝对路径。
/// 开发时是源码目录（src/desktop.ts，改完即跑、日志可读）；
/// 打包后是 resources/backend/src/server.mjs——捆成单文件的压缩产物，
/// 安装包里【没有任何后端源码】（源码直装 = 解压即读，踩过才知道要防）。
#[cfg(desktop)]
fn resource_script_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("找不到资源目录：{e}"))?;
    let packaged = resource_dir.join("backend").join("src").join("server.mjs");
    // tauri dev 也会把资源拷进 target/debug——但开发要跑的是仓库里的 TS 源码
    // （改完即生效、日志可读），所以 debug 构建先找源码、后找捆包。
    #[cfg(debug_assertions)]
    {
        if let Some(dev) = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|p| p.join("src").join("desktop.ts"))
            .filter(|p| p.exists())
        {
            return Ok(dev);
        }
    }
    if packaged.exists() {
        return Ok(packaged);
    }
    // 兜底：开发模式下直接指到仓库里的源码。
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.join("src").join("desktop.ts"))
        .filter(|p| p.exists())
        .ok_or_else(|| format!("找不到后端脚本。已尝试：{}", packaged.display()))?;
    Ok(dev)
}

/// 把 Windows 路径的反斜杠换成正斜杠。
///
/// 为什么必须做：sidecar 的命令行在拼接时，`\z`、`\t`、`\n` 这类序列会被
/// 当成转义处理，导致 `D:\z\...` 变成 `D:z...`。Windows 的 API 本身
/// 完全接受正斜杠，所以这是无损转换，比在两边加引号更可靠。
#[cfg(desktop)]
fn to_forward_slashes(path: &std::path::Path) -> String {
    // 注意：`\\?\` 长路径前缀在换成正斜杠后会失效，这里去掉它。
    // app_data_dir / resource_dir 返回的都是普通路径，不会触发长路径，
    // 所以去掉前缀是安全的。
    let text = path.to_string_lossy();
    let text = text.strip_prefix(r"\\?\").unwrap_or(&text);
    text.replace('\\', "/")
}

/// 极简百分号编码，只用于把错误页塞进 data: URL。
fn urlencode(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 2);
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// 后端起不来时显示的页面。给用户的是「为什么 + 怎么办」，不是一串堆栈。
fn error_page(message: &str) -> String {
    let escaped = message
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    format!(
        r#"<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<style>
  body{{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
       background:#161412;color:#e8e4df;font:15px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif}}
  .box{{max-width:420px;padding:32px;text-align:center}}
  h1{{font-size:17px;font-weight:600;margin:0 0 12px}}
  p{{color:#a8a099;margin:0;white-space:pre-wrap;font-size:13.5px}}
  .dot{{width:8px;height:8px;border-radius:50%;background:#c0553f;display:inline-block;margin-right:8px}}
</style></head><body><div class="box">
  <h1><span class="dot"></span>后端没能启动</h1>
  <p>{escaped}</p>
</div></body></html>"#
    )
}

// ── 窗口位置/尺寸的记忆（桌面）────────────────────────────
//
// 为什么自己写而不引 tauri-plugin-window-state：那个插件的恢复发生在它的 setup 里，
// 而我们的 main 窗口是在**自己的 setup 里现建**的（要先出加载页再去拉后端），
// 顺序上并不保证被它接住；自己存的行为完全可预期，还少一次联网拉 crate。
// 存的是逻辑像素（物理值除以 scale_factor），换 DPI 后旧存档不会把窗口撑出屏幕。

/// 一次存档的内容。`maximized` 单独存：最大化状态下 inner_size/position 是那个
/// 铺满屏幕的临时值，存下来下次还原会丢掉「原本想要的工作尺寸」。
#[cfg(desktop)]
#[derive(serde::Serialize, serde::Deserialize)]
struct WindowState {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    maximized: bool,
}

#[cfg(desktop)]
fn window_state_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    Some(app.path().app_data_dir().ok()?.join("window.json"))
}

/// 读存档。位置必须还落在某块屏的可视范围内（留 80px 的边，够抓住标题栏），
/// 否则当没有——拔掉外接屏后旧坐标在屏幕外，用户只会看到「程序在跑但看不见窗口」。
#[cfg(desktop)]
fn load_window_state(app: &tauri::AppHandle) -> Option<WindowState> {
    let raw = std::fs::read_to_string(window_state_file(app)?).ok()?;
    let state: WindowState = serde_json::from_str(&raw).ok()?;
    if state.width < 780.0 || state.height < 560.0 || !state.x.is_finite() || !state.y.is_finite() {
        return None;
    }
    let on_screen = app.available_monitors().ok()?.iter().any(|monitor| {
        let scale = monitor.scale_factor().max(1.0);
        let left = monitor.position().x as f64 / scale;
        let top = monitor.position().y as f64 / scale;
        let width = monitor.size().width as f64 / scale;
        let height = monitor.size().height as f64 / scale;
        state.x > left - width && state.x < left + width - 80.0
            && state.y > top - height && state.y < top + height - 20.0
    });
    on_screen.then_some(state)
}

#[cfg(desktop)]
fn save_window_state(app: &tauri::AppHandle) {
    let Some(path) = window_state_file(app) else { return };
    let Some(window) = app.get_webview_window("main") else { return };
    let (Ok(size), Ok(position), Ok(scale)) = (
        window.inner_size(),
        window.outer_position(),
        window.scale_factor(),
    ) else {
        return;
    };
    let state = WindowState {
        x: position.x as f64 / scale,
        y: position.y as f64 / scale,
        width: size.width as f64 / scale,
        height: size.height as f64 / scale,
        maximized: window.is_maximized().unwrap_or(false),
    };
    if let Ok(text) = serde_json::to_string(&state) {
        let _ = std::fs::write(path, text);
    }
}

/// 拖动/缩放事件一秒能发几十次，限频写盘；关窗与退出那一刻各必写一次。
#[cfg(desktop)]
fn save_window_state_throttled(app: &tauri::AppHandle) {
    static LAST_SAVE_MS: std::sync::Mutex<u128> = std::sync::Mutex::new(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    {
        let Ok(mut last) = LAST_SAVE_MS.lock() else { return };
        if now.saturating_sub(*last) < 1000 {
            return;
        }
        *last = now;
    }
    save_window_state(app);
}

// ── 托盘与开机自启（桌面）────────────────────────────────

/// 把主窗口恢复可见并夺回焦点。藏进托盘、最小化、被别的窗口压住，三种情况都走这一个函数——
/// 单实例回调和托盘菜单要的是同一个动作，分开写迟早两边不一致。
#[cfg(desktop)]
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(desktop)]
fn tray_enabled(app: &tauri::AppHandle) -> bool {
    app.try_state::<TrayState>()
        .and_then(|state| state.0.lock().ok().map(|v| *v))
        .unwrap_or(true)
}

/// 托盘图标 + 菜单。由 `apply_desktop_prefs` 按用户那个「托盘常驻」开关建或拆——
/// 开关本身是用户的决定，所以关掉之后**托盘图标也不留**，不是"图标常在、只是 × 的行为变"。
/// 「打开小茉」把藏起来或最小化的窗口唤回；「退出小茉」走 app.exit → RunEvent::Exit，
/// 那条路上才有"顺手杀 sidecar"，不留孤儿进程。
#[cfg(desktop)]
fn build_tray(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let open = MenuItem::with_id(app, "open", "打开小茉", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出小茉", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("小茉（仍在后台：她还会主动找你说话）")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    // 图标用应用自带那一份（同一个来源，不会出现「任务栏新、托盘旧」那种两张皮）。
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// 按偏好改系统登录项与托盘常驻。
/// 先拆再建：这条函数每次收到标记都会跑一遍，不先拆会出现两个托盘图标。
#[cfg(desktop)]
fn apply_desktop_prefs(app: &tauri::AppHandle, autostart: bool, tray: bool) {
    apply_autostart(app, autostart);
    if let Some(state) = app.try_state::<TrayState>() {
        if let Ok(mut current) = state.0.lock() {
            *current = tray;
        }
    }
    if tray {
        let _ = app.remove_tray_by_id(TRAY_ID);
        if let Err(error) = build_tray(app) {
            println!("[tray] 建托盘图标失败：{error}");
        }
    } else {
        let _ = app.remove_tray_by_id(TRAY_ID);
    }
}

/// 按偏好写/清系统登录项。
/// ⚠️ debug 构建（`npm run desktop`）一律不动：否则每次开发都会把
/// `target/debug/xiaomo-ai.exe` 注册成开机启动项，用户重启后弹出一个开发窗口。
#[cfg(desktop)]
fn apply_autostart(app: &tauri::AppHandle, enable: bool) {
    if cfg!(debug_assertions) {
        println!("[tray] debug 构建，跳过开机自启（enable={enable}）");
        return;
    }
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    let result = if enable { manager.enable() } else { manager.disable() };
    if let Err(error) = result {
        // 失败必须可见：用户以为开了自启，重启后却没有，是最难查的一类"没生效"。
        println!("[tray] 设置开机自启失败（enable={enable}）：{error}");
    }
}

/// 从 desktop.json 的内容里取两个布尔偏好（大写键，和 PORT / DATA_DIR 一路）。
#[cfg(desktop)]
fn prefs_from_json(value: &serde_json::Value) -> (bool, bool) {
    let flag = |key: &str, default: bool| {
        value.get(key).and_then(|v| v.as_bool()).unwrap_or(default)
    };
    // 两个缺省都跟 src/desktop-prefs.ts 的 DEFAULTS 对齐（用户拍的：默认都不开）。
    (flag("AUTOSTART", false), flag("TRAY", false))
}
