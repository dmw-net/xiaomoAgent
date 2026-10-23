import { useEffect, useRef, useState } from "react";
import { LanSection } from "./LanSection";
import type { ThemeMode } from "../../types/ui";
import { getAccent, setAccent, getClockPref, setClockPref, getListPageSize, setListPageSize, LIST_PAGE_SIZES, LIST_PAGE_LABEL, getThemeStyle, setThemeStyle, type ClockPref, type ThemeStyle } from "../../lib/ui-prefs";
import Modal from "../../components/Modal";
import { pickDirectory, relaunchApp } from "../../lib/native-dialog";
import { dataTransferApi, settingsApi } from "../../api";
import { disableNotifications, enableNotifications, getNotifyPref, notificationSupported } from "../../lib/notify";

/** 当前主题档（与 Rail 的快捷菜单读同一个真源：html[data-theme-mode]）。 */
function currentMode(): ThemeMode {
  return (document.documentElement.getAttribute("data-theme-mode") as ThemeMode) || "system";
}

const MODES: Array<{ key: ThemeMode; label: string }> = [
  { key: "light", label: "浅色" },
  { key: "dark", label: "深色" },
  { key: "system", label: "跟随系统" },
];

/**
 * 四套主题风格：同一套骨架（三栏 + 气泡）下的四种材质与配色。
 * 每一格给三个色点（底 / 卡片 / 强调），不必逐个点开就知道它是什么材质。
 * 色值只用于这一格预览，真正的取值在 legacy.css 的 [data-theme-style="…"] 里。
 */
const THEMES: Array<{ key: ThemeStyle; label: string; hint: string; swatch: [string, string, string] }> = [
  { key: "warm", label: "暖房", hint: "暖纸 + 赤陶，层级靠柔光", swatch: ["#f8f4ed", "#fffefb", "#ac4e2a"] },
  { key: "classic", label: "薄荷", hint: "浅灰白 + 薄荷绿，迁移前的旧观感", swatch: ["#faf9f7", "#ffffff", "#22c55e"] },
  { key: "night", label: "夜航", hint: "深蓝底 + 一盏蜜金", swatch: ["#12161d", "#1a2029", "#e4a951"] },
  { key: "paper", label: "和纸", hint: "暖纸 + 墨蓝，标题换宋体", swatch: ["#f6f1e8", "#fffdf8", "#2f5ea8"] },
];

/** 预设色系（空 = 跟随主题）。颜色一眼看出是哪个。 */
const ACCENTS: Array<{ hex: string; label: string }> = [
  { hex: "", label: "主题默认" },
  { hex: "#22c55e", label: "薄荷" },
  { hex: "#2f6fed", label: "湖蓝" },
  { hex: "#6f5bd8", label: "紫罗兰" },
  { hex: "#3b9e8e", label: "青瓷" },
  { hex: "#d9821c", label: "琥珀" },
];

const CLOCKS: Array<{ key: ClockPref; label: string; hint: string }> = [
  { key: "auto", label: "智能", hint: "换天显示日期，隔得久在气泡右下角标一次时间" },
  { key: "always", label: "每条显示", hint: "每条气泡右下角都带时间" },
  { key: "off", label: "极简隐藏", hint: "不显示任何日期/时间" },
];

/** 设置页「界面」tab：主题外观 / 色系 / 气泡时间 / 列表每页。后续同类偏好都收在这里。 */
export default function AppearanceSection({
  scope,
  dataDir,
  desktop,
}: {
  /** experience：外观、聊天显示与提醒；system：数据位置、启动与托盘。 */
  scope: "experience" | "system";
  dataDir: string;
  desktop: { autostart: boolean; tray: boolean } | null;
}): JSX.Element {
  const [mode, setMode] = useState<ThemeMode>(currentMode);
  const [style, setStyleState] = useState<ThemeStyle>(getThemeStyle);
  const [accent, setAccentState] = useState(getAccent);
  const [clock, setClockState] = useState<ClockPref>(getClockPref);
  const [listPage, setListPage] = useState(getListPageSize);
  // 「跟随主题」那一格的色点要显示当前主题自己的强调色——它是跟着风格走的，不是常量
  const themeAccent = THEMES.find((t) => t.key === style)?.swatch[2] ?? "#ac4e2a";
  const [notifyOn, setNotifyOn] = useState(getNotifyPref);
  const [notifyNote, setNotifyNote] = useState("");
  // 桌面两项偏好：本地先给个值，等快照到了以服务端为准（desktop 为 null 时整卡不显示）。
  const [prefs, setPrefs] = useState(desktop ?? { autostart: false, tray: true });
  const [prefsNote, setPrefsNote] = useState("");
  useEffect(() => {
    if (desktop) setPrefs(desktop);
  }, [desktop]);

  const toggleDesktop = (key: "autostart" | "tray", value: boolean): void => {
    const before = prefs;
    const next = { ...prefs, [key]: value };
    setPrefs(next); // 先落视觉，按钮不该等一次写盘才亮
    setPrefsNote("");
    void settingsApi.setDesktopPrefs({ [key]: value }).catch((error: unknown) => {
      setPrefs(before); // 写失败就退回原值——留着一个骗人的开关比没有开关更糟
      setPrefsNote(`没能改上：${error instanceof Error ? error.message : String(error)}`);
    });
  };
  // 数据存储位置：选目录 → 确认 → 迁移 → 一键重启。
  const [storeBusy, setStoreBusy] = useState(false);
  const [storeTarget, setStoreTarget] = useState<string | null>(null);
  const [storeNote, setStoreNote] = useState("");
  // 跨设备迁移：导出单文件备份；导入会覆盖当前库、图片与技能，所以必须二次确认并重启。
  const importFileRef = useRef<HTMLInputElement | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [transferBusy, setTransferBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [transferStatus, setTransferStatus] = useState<{ kind: "info" | "ok" | "bad"; text: string; percent?: number; indeterminate?: boolean }>({ kind: "info", text: "" });
  const setTransferInfo = (text: string, percent?: number, indeterminate = false): void => setTransferStatus({ kind: "info", text, percent, indeterminate });
  const setTransferError = (text: string): void => setTransferStatus({ kind: "bad", text });
  const setTransferOk = (text: string, percent?: number): void => setTransferStatus({ kind: "ok", text, percent });

  // 跟随系统时，系统切换也要保持高亮正确
  useEffect(() => {
    const paint = (): void => setMode(currentMode());
    try {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paint);
      return () => window.matchMedia("(prefers-color-scheme: dark)").removeEventListener("change", paint);
    } catch { return undefined; }
  }, []);

  const pick = (m: ThemeMode): void => {
    window.__setThemeMode?.(m);
    setMode(currentMode());
  };

  const pickAccent = (hex: string): void => {
    setAccent(hex);
    setAccentState(getAccent());
  };

  /** 换风格顺带把强调色放回「跟随主题」：主题是一个完整方案，
   *  留着上一套的强调色会让四套风格看着都差不多，等于白切。 */
  const pickTheme = (key: ThemeStyle): void => {
    setThemeStyle(key);
    setStyleState(key);
    setAccent("");
    setAccentState(getAccent());
  };

  const pickClock = (v: ClockPref): void => {
    setClockPref(v);
    setClockState(v);
  };

  const toggleNotify = (on: boolean): void => {
    if (!on) {
      disableNotifications();
      setNotifyOn(false);
      setNotifyNote("已关闭系统通知");
      return;
    }
    setNotifyNote("正在申请系统权限…");
    void enableNotifications().then((r) => {
      setNotifyOn(r.ok);
      setNotifyNote(r.ok ? "已开启：窗口不在前台时也能收到提醒" : (r.error || "没能开启"));
    });
  };

  const chooseFolder = (): void => {
    setStoreNote("");
    void pickDirectory().then((r) => {
      if (r.ok) setStoreTarget(r.path);
      else setStoreNote(r.error);
    });
  };
  const doMigrate = (): void => {
    if (storeTarget === null) return;
    setStoreBusy(true);
    setStoreNote("");
    settingsApi.changeDataDir(storeTarget)
      .then(async () => {
        setStoreTarget(null);
        setStoreNote("已迁移，正在重启…");
        const r = await relaunchApp();
        setStoreBusy(false);
        if (!r.ok) setStoreNote(`已迁移，但没能自动重启：${r.error ?? ""}。请手动重启应用。`);
      })
      .catch((e: Error) => { setStoreBusy(false); setStoreNote("迁移失败：" + e.message); });
  };

  const pickImport = (): void => {
    setTransferInfo("");
    importFileRef.current?.click();
  };

  const onImportFileChange = (): void => {
    const file = importFileRef.current?.files?.[0] ?? null;
    if (!file) return;
    if (!/\.(tar\.gz|tgz)$/i.test(file.name)) {
      setTransferError("请选择小茉导出的 .tar.gz 备份文件。");
      if (importFileRef.current) importFileRef.current.value = "";
      return;
    }
    setImportFile(file);
  };

  const doExport = (): void => {
    if (exportBusy) return;
    setExportBusy(true);
    setTransferInfo("正在生成并下载备份，请先不要关闭应用…", 1);
    dataTransferApi.exportDataArchive((loaded, total) => {
      if (total === null) {
        setTransferInfo(`正在生成并下载备份… ${(loaded / 1024 / 1024).toFixed(1)} MB`, 8, true);
      } else {
        const percent = Math.min(99, Math.round((loaded / total) * 100));
        setTransferInfo(`正在下载备份… ${percent}%（${(loaded / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB）`, percent);
      }
    })
      .then(({ blob, fileName }) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = fileName;
        link.style.display = "none";
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
        setTransferOk(`备份已导出：${fileName}`, 100);
      })
      .catch((e: Error) => {
        if (e instanceof dataTransferApi.DirectDownloadStarted) {
          setTransferOk(e.message, 100);
          return;
        }
        setTransferError("导出失败：" + e.message);
      })
      .finally(() => setExportBusy(false));
  };

  const doImport = (): void => {
    if (!importFile) return;
    setTransferBusy(true);
    setTransferInfo("正在上传备份，数据越多越久，请先不要关闭应用…", 0);
    dataTransferApi.importDataArchive(importFile, (loaded, total, phase) => {
      if (phase === "process") {
        setTransferInfo("上传完成，正在校验并替换数据…", 95);
      } else if (total === null) {
        setTransferInfo(`正在上传备份… ${(loaded / 1024 / 1024).toFixed(1)} MB`);
      } else {
        const percent = Math.min(94, Math.round((loaded / total) * 100));
        setTransferInfo(`正在上传备份… ${percent}%（${(loaded / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB）`, percent);
      }
    })
      .then(async (result) => {
        setImportFile(null);
        // 浏览器开发模式没有 Tauri 外壳，无法自动重启；导入本身已成功，不能报成失败。
        if (!("__TAURI_INTERNALS__" in window)) {
          setTransferOk(`${result.note} 当前不是桌面外壳，请手动重启应用或开发服务后继续使用。`, 100);
          return;
        }
        setTransferOk(result.note + " 正在重启…", 100);
        const r = await relaunchApp();
        if (!r.ok) {
          setTransferError(`${result.note} ${r.error ?? "自动重启失败，请手动退出并重新打开小茉。"}`);
        }
      })
      .catch((e: Error) => setTransferError("导入失败：" + e.message))
      .finally(() => {
        setTransferBusy(false);
        if (importFileRef.current) importFileRef.current.value = "";
      });
  };

  return (
    <>
      {scope === "experience" && (
        <>
      <div className="card card-pad">
        <div className="subhead">主题风格</div>
        <div className="hint">换一套材质与配色。切换风格会用回该风格的默认强调色。</div>
        <div className="preset-row" role="group" aria-label="主题风格">
          {THEMES.map((t) => (
            <button key={t.key} type="button" className="preset theme-btn" aria-pressed={style === t.key}
              title={t.hint} onClick={() => pickTheme(t.key)}>
              <span className="theme-swatch" aria-hidden="true">
                <i style={{ background: t.swatch[0] }} />
                <i style={{ background: t.swatch[1] }} />
                <i style={{ background: t.swatch[2] }} />
              </span>
              {t.label}
            </button>
          ))}
        </div>
        <div className="subhead">明暗</div>
        <div className="hint">「跟随系统」随系统的深浅色自动切换。</div>
        <div className="preset-row" role="group" aria-label="明暗">
          {MODES.map((m) => (
            <button key={m.key} type="button" className="preset" aria-pressed={mode === m.key}
              onClick={() => pick(m.key)}>{m.label}</button>
          ))}
        </div>
        <div className="subhead acc-head">色系</div>
        <div className="hint">换一套强调色，按钮和发送键都会跟着变。</div>
        <div className="preset-row" role="group" aria-label="色系">
          {ACCENTS.map((a) => (
            <button key={a.label} type="button" className="preset acc-btn" aria-pressed={accent === a.hex}
              onClick={() => pickAccent(a.hex)}>
              <span className="acc-dot" style={{ background: a.hex || themeAccent }} />{a.label}
            </button>
          ))}
          <label className="acc-custom" title="自定义任意颜色">
            <input type="color" value={accent || themeAccent}
              aria-label="自定义强调色"
              onChange={(e) => pickAccent(e.target.value)} />
            <span>自定义</span>
          </label>
        </div>
      </div>

      <div className="card card-pad" style={{ marginTop: 12 }}>
        <div className="subhead">气泡时间</div>
        <div className="hint">聊天里日期与时间的显示方式，只影响这台设备上的界面。</div>
        <div className="preset-row" role="group" aria-label="气泡时间">
          {CLOCKS.map((c) => (
            <button key={c.key} type="button" className="preset" aria-pressed={clock === c.key}
              title={c.hint} onClick={() => pickClock(c.key)}>{c.label}</button>
          ))}
        </div>
        <div className="hint" style={{ marginTop: 6 }}>
          {CLOCKS.find((c) => c.key === clock)?.hint}
        </div>
      </div>

      <div className="card card-pad" style={{ marginTop: 12 }}>
        <div className="subhead">列表每页</div>
        <div className="hint">
          清单一类页面每页显示多少条。
        </div>
        <div className="preset-row" role="group" aria-label="列表每页" style={{ marginTop: 6 }}>
          {LIST_PAGE_SIZES.map((n) => (
            <button key={n} type="button" className="preset" aria-pressed={listPage === n}
              onClick={() => { setListPageSize(n); setListPage(n); }}>{LIST_PAGE_LABEL[n]}</button>
          ))}
        </div>
      </div>

      <div className="card card-pad" style={{ marginTop: 12 }}>
        <div className="subhead">消息提醒</div>
        <div className="hint">
          后台有新消息、或收到主动消息时发系统通知；点通知回到那段会话。
        </div>
        <div className="preset-row" role="group" aria-label="消息提醒" style={{ marginTop: 6 }}>
          <button type="button" className="preset" aria-pressed={!notifyOn}
            disabled={!notificationSupported()} onClick={() => toggleNotify(false)}>关闭</button>
          <button type="button" className="preset" aria-pressed={notifyOn}
            disabled={!notificationSupported()} onClick={() => toggleNotify(true)}>开启</button>
        </div>
        <div className="hint" style={{ marginTop: 6 }}>
          {notifyNote || (notificationSupported() ? "权限由系统管理，可随时在这里关闭。" : "当前环境不支持系统通知。")}
        </div>
      </div>

        </>
      )}

      {scope === "system" && (
        <>
      <div className="card card-pad" style={{ marginTop: 12 }}>
        <div className="subhead">数据存储位置</div>
        <div className="hint">
          对话、记忆、图片、技能都在这个目录里。可改到别处（比如 D 盘），改时会把现有数据一起搬过去。
        </div>
        <div className="field">
          <label>当前位置</label>
          <div className="hint" style={{ wordBreak: "break-all" }}>
            <code>{dataDir || "（开发模式：跟随项目 ./data）"}</code>
          </div>
        </div>
        <div className="actions">
          <button type="button" className="pf-ghost" disabled={storeBusy} onClick={chooseFolder}>选择文件夹…</button>
        </div>
        {storeNote && <div className="hint" style={{ marginTop: 6 }}>{storeNote}</div>}
      </div>

      <div className="card card-pad" style={{ marginTop: 12 }}>
        <div className="subhead">跨设备数据迁移</div>
        <div className="hint">
          导出包包含对话、记忆、联系人、模型设置、图片和自定义技能；也包含已保存的 API Key，请只通过可信方式传输。
          如果“一键导出备份”被浏览器扩展中断，可以点“直接下载”。
        </div>
        <div className="actions" style={{ marginTop: 8 }}>
          <button type="button" className="pf-ghost" disabled={exportBusy} onClick={doExport}>
            {exportBusy ? "正在导出…" : "一键导出备份"}
          </button>
          <a className="pf-ghost" href={dataTransferApi.EXPORT_URL} download>
            直接下载
          </a>
          <button type="button" className="pf-ghost" disabled={transferBusy} onClick={pickImport}>
            选择备份并导入
          </button>
          <input ref={importFileRef} type="file" accept=".tar.gz,.tgz,application/gzip"
            style={{ display: "none" }} onChange={onImportFileChange} />
        </div>
        {transferStatus.text && (
          <div className={`banner show ${transferStatus.kind === "info" ? "" : transferStatus.kind}`} role={transferStatus.kind === "bad" ? "alert" : "status"}>
            <div className="body">
              <div>{transferStatus.text}</div>
              {transferStatus.percent !== undefined && (
                <div className={`transfer-progress${transferStatus.indeterminate ? " indeterminate" : ""}`} aria-label="数据迁移进度">
                  <span style={{ width: `${Math.max(2, Math.min(100, transferStatus.percent))}%` }} />
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <LanSection />

      {desktop !== null && (
        <div className="card card-pad" style={{ marginTop: 12 }}>
          <div className="subhead">开机与关窗</div>
          <div className="hint">
            窗口关闭后是否继续收发消息、主动找你，由下面两项决定。
          </div>

          <div className="field" style={{ marginTop: 8 }}>
            <label>开机自动启动</label>
            <div className="preset-row" role="group" aria-label="开机自动启动" style={{ marginTop: 6 }}>
              <button type="button" className="preset" aria-pressed={!prefs.autostart}
                onClick={() => toggleDesktop("autostart", false)}>关闭</button>
              <button type="button" className="preset" aria-pressed={prefs.autostart}
                onClick={() => toggleDesktop("autostart", true)}>开启</button>
            </div>
          </div>

          <div className="field" style={{ marginTop: 12 }}>
            <label>托盘常驻</label>
            <div className="hint">
              开启：关窗只是收进托盘继续运行，右键托盘图标选「退出小茉」才真正退出。关闭：关窗即退出。
            </div>
            <div className="preset-row" role="group" aria-label="托盘常驻" style={{ marginTop: 6 }}>
              <button type="button" className="preset" aria-pressed={!prefs.tray}
                onClick={() => toggleDesktop("tray", false)}>关闭</button>
              <button type="button" className="preset" aria-pressed={prefs.tray}
                onClick={() => toggleDesktop("tray", true)}>开启</button>
            </div>
          </div>

          {prefsNote !== "" && <div className="hint" style={{ marginTop: 6 }}>{prefsNote}</div>}
        </div>
      )}

      {importFile !== null && (
        <Modal label="导入备份并覆盖本机数据？" onClose={() => { if (!transferBusy) setImportFile(null); }}>
          <div className="del-title">导入备份并覆盖本机数据？</div>
          <div className="del-note">
            将导入：<br /><code>{importFile.name}</code>
            <br />当前这台机器上的对话、记忆、图片、技能和设置会被备份内容替换。导入完成后需要重启。
            {transferBusy && (
              <>
                <div style={{ marginTop: 10 }}>{transferStatus.text}</div>
                {transferStatus.percent !== undefined && (
                  <div className="transfer-progress" aria-label="导入进度">
                    <span style={{ width: `${Math.max(2, Math.min(100, transferStatus.percent))}%` }} />
                  </div>
                )}
              </>
            )}
            {!transferBusy && transferStatus.kind === "bad" && transferStatus.text && (
              <div className="transfer-error" role="alert">{transferStatus.text}</div>
            )}
          </div>
          <div className="del-row">
            <button type="button" disabled={transferBusy} onClick={() => setImportFile(null)}>取消</button>
            <button type="button" className="danger" disabled={transferBusy} onClick={doImport}>
              {transferBusy ? "正在导入，请勿关闭…" : "覆盖导入并重启"}
            </button>
          </div>
        </Modal>
      )}

      {storeTarget !== null && (
        <Modal label="迁移数据到新位置？" onClose={() => setStoreTarget(null)}>
          <div className="del-title">迁移数据到新位置？</div>
          <div className="del-note">
            现有数据会搬到：
            <br /><code style={{ wordBreak: "break-all" }}>{storeTarget}</code>
            <br />重启后生效；期间的新对话不会带过去。
          </div>
          <div className="del-row">
            <button type="button" onClick={() => setStoreTarget(null)}>取消</button>
            <button type="button" className="primary" disabled={storeBusy} onClick={doMigrate}>
              {storeBusy ? "迁移中…" : "迁移并重启"}
            </button>
          </div>
        </Modal>
      )}
        </>
      )}
    </>
  );
}
