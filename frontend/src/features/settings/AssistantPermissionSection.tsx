// 设置页「设置助手权限」小卡：三档单选，点选即存。
//
// 档位的语义由后端工具层执行（readonly 整组摘工具、confirm 挂确认卡片、auto 全放），
// 这里只负责把选择递过去——界面上不做第二遍闸门，也绝不假装改成功。

import { useEffect, useState } from "react";
import { assistantApi, type AssistantPermission } from "../../api";

const TIERS: Array<{ key: AssistantPermission; label: string; desc: string }> = [
  { key: "readonly", label: "只读", desc: "只回答问题，不调用任何改配置工具。" },
  { key: "confirm", label: "变更前确认", desc: "可逆操作直接执行；高风险操作先弹出确认卡片。" },
  { key: "auto", label: "完全自主", desc: "连续完成配置操作，不再逐步询问。" },
];

export default function AssistantPermissionSection(): JSX.Element {
  const [permission, setPermission] = useState<AssistantPermission | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    assistantApi.getPermission()
      .then((r) => setPermission(r.permission))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  const pick = (next: AssistantPermission): void => {
    if (busy || next === permission) return;
    setBusy(true);
    setErr("");
    assistantApi.setPermission(next)
      .then((r) => setPermission(r.permission))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="section assistant-permission-section" id="settings-assistant">
      <h2>设置助手权限</h2>
      <div className="desc">
        决定内置设置助手可以自动完成哪些配置。限制作用在工具层，不依赖提示词。
      </div>
      {err && <div className="banner show bad" role="alert"><div className="body">{err}</div></div>}
      <div className="permission-options">
        {TIERS.map((t) => (
          <label key={t.key} className={"permission-option" + (permission === t.key ? " on" : "")}>
            <input type="radio" name="assistant-permission" checked={permission === t.key}
              disabled={busy || permission === null} onChange={() => pick(t.key)} />
            <span className="permission-copy">
              <b>{t.label}</b>
              <span>{t.desc}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

