import { useState } from "react";
import { openExternal } from "../lib/open-external";
import { checkForUpdate, installUpdate } from "../lib/check-update";

const RELEASES_URL = "https://github.com/dmw-net/xiaomoAgent/releases";

/**
 * 外壳里 <a target="_blank"> 点了没反应，外链统一走这里（见 open-external.ts）。
 * 打开失败时把原因和原始地址摊在这一行下面：从前只写 console.warn，
 * 用户看到的就是「点了没反应」，连该怪谁都不知道。
 */
function ExtLink({ href, children }: { href: string; children: string }): JSX.Element {
  const [note, setNote] = useState("");
  const open = async (): Promise<void> => {
    setNote("");
    const r = await openExternal(href);
    if (r.ok) return;
    // 复制只在真成功时才说「已复制」——剪贴板本身也可能不可用。
    let copied = false;
    try {
      await navigator.clipboard.writeText(href);
      copied = true;
    } catch {
      copied = false;
    }
    setNote(`${r.error} · ${copied ? "链接已复制到剪贴板：" : "请手动打开："}${href}`);
  };
  return (
    <>
      <a href={href} target="_blank" rel="noreferrer"
        onClick={(e) => { e.preventDefault(); void open(); }}>{children}</a>
      {note !== "" && <span className="about-link-note">{note}</span>}
    </>
  );
}

type Phase =
  | { s: "idle" }
  | { s: "checking" }
  | { s: "current" }
  | { s: "available"; version: string; notes: string }
  | { s: "busy"; text: string }
  | { s: "error"; text: string };

/** 更新说明整段是 Markdown，这一行只放第一句，长了截掉——多行会把「关于」撑成一页。 */
function firstLine(notes: string): string {
  const line = notes.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "") ?? "";
  return line.length > 40 ? line.slice(0, 40) + "…" : line;
}

/**
 * 「检查更新」这一行只在桌面外壳里存在：浏览器打开的是别人部署的服务端，
 * 端上没有可安装的东西，放个按下去只会报错的键比不放更糟。
 */
function UpdateRow(): JSX.Element {
  const [phase, setPhase] = useState<Phase>({ s: "idle" });

  const check = async (): Promise<void> => {
    setPhase({ s: "checking" });
    const r = await checkForUpdate();
    if (r.kind === "current") setPhase({ s: "current" });
    else if (r.kind === "available") setPhase({ s: "available", version: r.version, notes: r.notes });
    else setPhase({ s: "error", text: r.error });
  };

  const install = async (): Promise<void> => {
    setPhase({ s: "busy", text: "下载中…" });
    const r = await installUpdate((p) => setPhase({
      s: "busy",
      text: p.kind === "installing" ? "正在安装，小茉马上重开…"
        : p.percent === null ? "下载中…" : `下载中 ${p.percent}%`,
    }));
    if (r.kind === "launched") setPhase({ s: "busy", text: "安装程序已启动，小茉马上重开…" });
    else setPhase({ s: "error", text: r.error });
  };

  const note = phase.s === "checking" ? "检查中…"
    : phase.s === "current" ? "已经是最新版本"
    : phase.s === "available" ? `发现新版本 v${phase.version}${firstLine(phase.notes) ? `：${firstLine(phase.notes)}` : ""}`
    : phase.s === "busy" || phase.s === "error" ? phase.text
    : "";

  return (
    <div className="about-update">
      {phase.s === "available" ? (
        <button type="button" className="btn" onClick={() => void install()}>立即更新</button>
      ) : (
        <button type="button" className="btn"
          disabled={phase.s === "checking" || phase.s === "busy"}
          onClick={() => void check()}>检查更新</button>
      )}
      <span className="about-update-note" role="status" aria-live="polite">
        {note}
        {phase.s === "error" && <ExtLink href={RELEASES_URL}>　去发布页下载</ExtLink>}
      </span>
    </div>
  );
}

/** 关于小茉的正文：桌面「更多 → 关于小茉」弹窗与设置页「关于」标签共用这一份。 */
export default function AboutBody(): JSX.Element {
  // 更新器只存在于外壳里；浏览器里这一行整块不出现（不是禁着灰，是不给假入口）。
  const inShell = "__TAURI_INTERNALS__" in window;
  return (
    <>
      <img className="about-mark" src="/icon.png" alt="小茉" width="56" height="56" />
      <div className="about-name">小茉 <span>{__APP_VERSION__}</span></div>
      <div className="about-line">本地运行的陪伴型 AI 助手：支持长期记忆、主动提醒、多角色对话与语音、图片等能力。</div>
      <div className="about-dev">
        开发者：<ExtLink href="https://github.com/dmw-net">dmw-net</ExtLink>
        <span className="about-dev-sep">·</span>
        建议与问题反馈：<ExtLink href="https://github.com/dmw-net/xiaomoAgent/issues">去反馈</ExtLink>
      </div>
      {inShell && <UpdateRow />}
      <div className="about-legal">
        <div><b>免责声明</b>　回复均由 AI 生成，可能存在不准确之处，仅供参考，不构成医疗、法律、金融等专业建议；重要决定请以专业意见为准。</div>
        <div><b>合规使用</b>　本应用仅供个人学习与生活使用。请遵守相关法律法规，勿输入或传播违法违规、侵害他人权益的内容；请勿将应用用于冒充真人或误导他人的场景。</div>
        <div><b>数据说明</b>　对话、记忆与设置全部保存在你自己的设备上，开发者不收集、不上传你的任何数据；你接入的模型服务商按其自身条款处理请求内容。</div>
      </div>
    </>
  );
}
