//! 构建脚本：除了常规的 tauri-build 代码生成，还负责把更新公钥烧成编译期常量。
//!
//! `RESOURCE_PUBKEY_B64`（lib.rs 的资源完整性校验用）**不在 Rust 里手抄**，而是每次
//! 构建都从 `tauri.conf.json` 的 `plugins.updater.pubkey` 现读现生成——这两处用的
//! 本来就是同一把发版密钥，手抄两份只会漂。
//!
//! 2026-10-17 实测漂过一次：lib.rs 那份的 minisign `untrusted comment` 行写着
//! `…E664C16445FA4E76`，而从第 2 行解出来的真 keyID 是 `E664C16445FA4E7F`。
//! 验签一点没受影响（minisign 只看第 2 行），受影响的是人：拿这两行一对，会得出
//! "换过钥匙、已发的包全要砖"的相反结论。现在这个值只有一个来源。

use std::path::PathBuf;

fn main() {
    // 公钥换了必须重跑本脚本，否则常量会停在旧值上：lib.rs 并不依赖 tauri.conf.json，
    // 光靠 cargo 的默认重跑规则（包内文件变动）不保险。
    println!("cargo:rerun-if-changed=tauri.conf.json");

    let conf_path = PathBuf::from("tauri.conf.json");
    let raw = std::fs::read_to_string(&conf_path)
        .unwrap_or_else(|e| panic!("读不到 {}：{e}", conf_path.display()));
    let conf: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("{} 不是合法 JSON：{e}", conf_path.display()));

    let pubkey = conf
        .get("plugins")
        .and_then(|plugins| plugins.get("updater"))
        .and_then(|updater| updater.get("pubkey"))
        .and_then(|pubkey| pubkey.as_str())
        .unwrap_or_else(|| {
            panic!(
                "{} 里没有 plugins.updater.pubkey——更新与资源校验都靠它，补上再构建",
                conf_path.display()
            )
        });

    // 边界：只读基座 tauri.conf.json。Tauri 还支持平台叠加文件（tauri.<platform>.conf.json），
    // 万一将来有人把 pubkey 只写在那里，这里就看不见了——真出现这种情况要一起改。
    // cargo 会把这行带到 rustc 的环境里，lib.rs 用 env! 取；值就是 conf 里那串原文。
    // 不走“写文件 + include!”是因为那个组合在 out/ 被单独删掉时会以
    // “couldn't read …resource_pubkey.rs” 这种看不出所以然的错误炸掉编译。
    println!("cargo:rustc-env=XIAOMO_RESOURCE_PUBKEY_B64={pubkey}");

    tauri_build::build()
}
