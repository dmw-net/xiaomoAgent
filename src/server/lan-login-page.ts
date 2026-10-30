// 手机第一次打开时看到的登录页（sendLanLogin 的 HTML 本体）。
// 单独一个文件：这段自包含的内联样式+脚本有几百行，塞进任何路由模块都会让它没法读。
// 刻意**不依赖任何站点资源**：那时请求还没有 cookie，前端包也取不到，所以样式全内联。

import type { ServerResponse } from "node:http";
import { sendHtml } from "./http.ts";

export function sendLanLogin(response: ServerResponse): void {
  sendHtml(response, `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>小茉 · 输入访问码</title>
<style>
 :root{--bg:#efe7da;--fg:#2b241d;--card:#fffdfa;--line:#d9cdbb;--accent:#b7522f}
 @media (prefers-color-scheme:dark){:root{--bg:#171310;--fg:#f0e8dd;--card:#221c18;--line:#3a302a;--accent:#e08a5f}}
 *{box-sizing:border-box}
 body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
      background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
 form{width:100%;max-width:340px;padding:24px;background:var(--card);border:1px solid var(--line);border-radius:16px}
 h1{margin:0 0 6px;font-size:19px}
 p{margin:0 0 18px;font-size:13px;opacity:.72}
 input{width:100%;padding:12px 14px;font-size:20px;letter-spacing:.14em;text-align:center;
       border:1px solid var(--line);border-radius:10px;background:transparent;color:inherit}
 #remember{display:flex;align-items:center;gap:8px;margin-top:12px;font-size:13px;opacity:.75;cursor:pointer;user-select:none}
 #remember input{width:auto;margin:0;padding:0;border:0;border-radius:0;background:none;accent-color:var(--accent)}
 button{margin-top:12px;width:100%;padding:12px;border:0;border-radius:10px;background:var(--accent);color:#fff;font-size:15px}
 button:disabled{opacity:.6;cursor:progress}
 #err{margin-top:10px;min-height:18px;font-size:13px;color:#c0392b}
</style></head>
<body>
<form id="f">
  <h1>小茉</h1>
  <p id="tip">输入电脑上显示的访问码</p>
  <input id="c" inputmode="numeric" autocomplete="off" placeholder="000-000" autofocus>
  <label id="remember"><input id="r" type="checkbox" checked> 记住访问码</label>
  <button id="go" type="submit">进入</button>
  <div id="err"></div>
</form>
<script>
// 局域网二维码会把访问码放在 #code= 后面（fragment 不经过网络），扫过来时直接预填。
// 「记住访问码」把它存在本机 localStorage：下次打开同一地址时自动进入，不用再手输。
// 服务端 cookie 仍然是一年有效的第一道保险；localStorage 只是 cookie 被清掉时的兜底。
const KEY = "xiaomo.lan.code";
const form = document.getElementById("f");
const codeInput = document.getElementById("c");
const remember = document.getElementById("r");
const go = document.getElementById("go");
const tip = document.getElementById("tip");
const err = document.getElementById("err");

const digitsOf = (value) => String(value || "").replace(/\\D/g, "").slice(0, 12);
const shown = (digits) => digits.length === 6 ? digits.slice(0, 3) + "-" + digits.slice(3) : digits;
function readSaved() {
  try { return digitsOf(localStorage.getItem(KEY)); } catch { return ""; }
}
function writeSaved(digits) {
  try {
    if (remember.checked) localStorage.setItem(KEY, digits);
    else localStorage.removeItem(KEY);
  } catch { /* 隐私模式没有 localStorage：服务端 cookie 仍然有效 */ }
}
function clearSaved() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  err.textContent = "";
  const digits = digitsOf(codeInput.value);
  if (digits.length < 6) { err.textContent = "至少 6 位数字"; return; }
  go.disabled = true;
  try {
    const r = await fetch("/__lan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: digits }),
    });
    if (r.ok) { writeSaved(digits); location.replace("/"); return; }
    const data = await r.json().catch(() => ({}));
    // 记住的码已经不对了（换过码）：清掉，别让下次打开再自动撞一次。
    if (r.status === 401) clearSaved();
    err.textContent = data.error || "访问码不对";
  } catch {
    err.textContent = "连不上，确认还在同一局域网";
  }
  go.disabled = false;
});

// 二维码里的码优先于记住的码（那是刚扫的，更新鲜）；二维码仍然要用户点一次「进入」，
// 避免打开别人发来的旧链接就悄悄登录。只有「自己记住的码」才自动提交。
const preset = digitsOf(new URLSearchParams(location.hash.slice(1)).get("code"));
const saved = readSaved();
const initial = preset.length >= 6 ? preset : (saved.length >= 6 ? saved : "");
if (initial !== "") {
  codeInput.value = shown(initial);
  if (preset.length >= 6) {
    tip.textContent = "已自动填好，点「进入」";
    go.focus();
  } else {
    tip.textContent = "正在自动进入…";
    remember.checked = true;
    setTimeout(() => form.requestSubmit(), 0);
  }
}
remember.addEventListener("change", () => { if (!remember.checked) clearSaved(); });
</script>
</body></html>`);
}
