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

    // 资产加密密钥（scripts/gen-asset-key.mjs 生成、cjk-encode 用它编中文载荷）：
    // 烧成编译期常量，lib.rs spawn sidecar 时经 XM_ASSET_KEY 环境变量交给运行时。
    // 密钥文件变了必须重编译（常量是编译期的），所以挂 rerun-if-changed。
    // 找不到文件直接 panic：release 没有密钥 = 产物解码必炸，宁可编译失败也不产出坏包。
    //
    // ⚠️ 不直接烧 base64 原文：env! 常量会原样落进 .rdata，`strings xiaomo-ai.exe`
    // 一条命令就能捞出 44 字符的密钥（exe 里还有 updater 公钥也是 base64，混在一起
    // 虽然要多看一眼，但那不是保护）。存 XOR 0xA5 后的 hex，运行时还原——
    // 把「strings 捞密钥」抬成「得读懂 deobfuscate_asset_key」。
    println!("cargo:rerun-if-changed=../dist-desktop/asset-key.txt");
    let key_path = PathBuf::from("../dist-desktop/asset-key.txt");
    let key = std::fs::read_to_string(&key_path).unwrap_or_else(|e| {
        panic!(
            "读不到 {}：{e}\n先跑 node scripts/gen-asset-key.mjs 生成资产密钥再构建",
            key_path.display()
        )
    });
    let key = key.trim();
    if base64_len(key) < 16 {
        panic!("dist-desktop/asset-key.txt 解出不足 16 字节，密钥文件损坏——删掉后重跑 node scripts/gen-asset-key.mjs");
    }
    let obfuscated: String = key.bytes().map(|b| format!("{:02x}", b ^ 0xA5)).collect();
    println!("cargo:rustc-env=XIAOMO_ASSET_KEY_OBF={obfuscated}");

    tauri_build::build()
}

/// 宽松校验 base64 长度：4 字符 ≈ 3 字节，32 字节密钥 ≈ 44 字符。
/// 不引依赖、不做严格解码——严格解码在 gen-asset-key / bundle-backend 已经做过，
/// 这里只防"文件被写坏成别的东西"这种最粗的错。
fn base64_len(s: &str) -> usize {
    let chars = s.bytes().filter(|b| b.is_ascii_alphanumeric() || *b == b'+' || *b == b'/' || *b == b'=').count();
    chars / 4 * 3
}
