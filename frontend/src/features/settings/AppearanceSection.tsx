import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { LanSection } from "./LanSection";
import type { ThemeMode } from "../../types/ui";
import { ACCENT_PRESETS, getAccent, setAccent, getClockPref, setClockPref, getShowTokensPerSec, setShowTokensPerSec, getShowTtsButton, setShowTtsButton, getListPageSize, setListPageSize, LIST_PAGE_SIZES, LIST_PAGE_LABEL, getWallpaper, setWallpaper, getWallpaperLibrary, addWallpaperLibraryItem, removeWallpaperLibraryItem, WALLPAPER_LIB_EVENT, DEFAULT_WALLPAPER, getLastBackupAt, markBackupCompleted, type ClockPref, type WallpaperPref, type WallpaperItem } from "../../lib/ui-prefs";
import { WALLPAPER_PRESETS, wallpaperPreset } from "../../lib/wallpaper";
import Modal from "../../components/Modal";
import DiagnosticsButton from "../../components/DiagnosticsButton";
import MediaMaintenanceDialog from "../../components/MediaMaintenanceDialog";
import StorageCleanupDialog from "../../components/StorageCleanupDialog";
import { pickDirectory, relaunchApp } from "../../lib/native-dialog";
import { revealInFolder } from "../../lib/reveal-folder";
import { dataTransferApi, settingsApi, wallpaperApi } from "../../api";
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

/** 强调色只是个性化点缀；材质、字体、层级和语义色始终使用同一套品牌底座。 */
const ACCENTS = ACCENT_PRESETS;

const CLOCKS: Array<{ key: ClockPref; label: string; hint: string }> = [
  { key: "auto", label: "智能", hint: "换天显示日期与当天首条时间，隔得久再在气泡右下角标一次时间" },
  { key: "always", label: "每条显示", hint: "每条气泡右下角都带时间" },
  { key: "off", label: "极简隐藏", hint: "不显示任何日期/时间" },
];

/** 图片/视频壁纸的客户端预检：给用户一个立刻的「太大了」，不等一次注定失败的上传。 */
const WP_IMAGE_MAX = 5 * 1024 * 1024;
const WP_VIDEO_MAX = 100 * 1024 * 1024;/** 设置页「体验与提醒」：显示模式、强调色、壁纸、聊天显示与通知。 */
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
  const [accent, setAccentState] = useState(getAccent);
  const [clock, setClockState] = useState<ClockPref>(getClockPref);
  const [speedOn, setSpeedOnState] = useState<boolean>(getShowTokensPerSec);
  const [ttsBtnOn, setTtsBtnOnState] = useState<boolean>(getShowTtsButton);
  const [listPage, setListPage] = useState(getListPageSize);
  const [wallpaper, setWallpaperState] = useState<WallpaperPref>(getWallpaper);
  const [wallpaperLib, setWallpaperLib] = useState<WallpaperItem[]>(getWallpaperLibrary);
  const [wpNote, setWpNote] = useState("");
  const [wpBusy, setWpBusy] = useState(false);
  const wpFileRef = useRef<HTMLInputElement | null>(null);
  /** 壁纸开着 = 界面处于壁纸适配：浅色/深色暂停生效，显示模式控件换成状态徽标。 */
  const wallpaperOn = wallpaper.kind !== "none";
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
  const [mediaOpen, setMediaOpen] = useState(false);
  const [storageOpen, setStorageOpen] = useState(false);
  // 跨设备迁移：导出单文件备份；导入会覆盖当前库、图片与技能，所以必须二次确认并重启。
  const importFileRef = useRef<HTMLInputElement | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [transferBusy, setTransferBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [transferStatus, setTransferStatus] = useState<{ kind: "info" | "ok" | "bad"; text: string; percent?: number; indeterminate?: boolean }>({ kind: "info", text: "" });
  // 桌面端原生下载完成后 Tauri 会回报落盘绝对路径；浏览器端拿不到真实路径（只有文件名），保持 null。
  const [savedBackupPath, setSavedBackupPath] = useState<string | null>(null);
  const [lastBackupAt, setLastBackupAt] = useState<number | null>(getLastBackupAt);
  const nativeDownloadSeen = useRef(false);
  const nativeDownloadTimer = useRef<number | null>(null);
  const setTransferInfo = (text: string, percent?: number, indeterminate = false): void => setTransferStatus({ kind: "info", text, percent, indeterminate });
  const setTransferError = (text: string): void => setTransferStatus({ kind: "bad", text });
  const setTransferOk = (text: string, percent?: number): void => setTransferStatus({ kind: "ok", text, percent });

  // 跟随系统时系统切换要跟着变；Rail 快捷菜单改了主题也要跟着变
  // （index.html 在 __setThemeMode 里广播 xiaomo:themechange）。
  useEffect(() => {
    const paint = (): void => setMode(currentMode());
    document.addEventListener("xiaomo:themechange", paint);
    try {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paint);
      return () => {
        document.removeEventListener("xiaomo:themechange", paint);
        window.matchMedia("(prefers-color-scheme: dark)").removeEventListener("change", paint);
      };
    } catch {
      document.removeEventListener("xiaomo:themechange", paint);
      return undefined;
    }
  }, []);

  // 我的壁纸收藏被增删（上传/删除都走 ui-prefs 的事件，这里只管跟着重读）
  useEffect(() => {
    const sync = (): void => setWallpaperLib(getWallpaperLibrary());
    window.addEventListener(WALLPAPER_LIB_EVENT, sync);
    return () => window.removeEventListener(WALLPAPER_LIB_EVENT, sync);
  }, []);
  // 桌面下载结果由 Tauri 回报：XHR 拿不到 attachment，只有原生下载完成事件才是真完成。
  useEffect(() => {
    let disposed = false;
    let unlisten = (): void => {};
    void dataTransferApi.listenBackupDownload((event) => {
      if (disposed) return;
      nativeDownloadSeen.current = true;
      if (nativeDownloadTimer.current !== null) {
        window.clearTimeout(nativeDownloadTimer.current);
        nativeDownloadTimer.current = null;
      }
      if (event.phase === "started") {
        setSavedBackupPath(null);
        setExportBusy(true);
        setTransferInfo(event.path ? `正在保存到：${event.path}` : "正在保存备份…", 5, true);
        return;
      }
      setExportBusy(false);
      if (event.phase === "finished") {
        markBackupCompleted();
        setLastBackupAt(getLastBackupAt());
        setSavedBackupPath(event.path || null);
        setTransferOk(event.path ? `备份已保存：${event.path}` : "备份已保存到系统下载目录", 100);
      } else {
        setTransferError(event.message || "桌面下载没有完成，请重试。");
      }
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(() => {
      if (!disposed) setTransferError("桌面下载通道没有启动，请重启应用后再试。");
    });
    return () => {
      disposed = true;
      unlisten();
      if (nativeDownloadTimer.current !== null) window.clearTimeout(nativeDownloadTimer.current);
    };
  }, []);

  const pick = (m: ThemeMode): void => {
    if (wallpaperOn) return; // 壁纸模式下不提供明暗切换（控件已换成状态徽标，键盘用户也进不来）
    window.__setThemeMode?.(m);
    setMode(currentMode());
  };

  const pickAccent = (hex: string): void => {
    setAccent(hex);
    setAccentState(getAccent());
  };


  const pickClock = (v: ClockPref): void => {
    setClockPref(v);
    setClockState(v);
  };

  const pickSpeed = (on: boolean): void => {
    setShowTokensPerSec(on);
    setSpeedOnState(on);
  };

  const pickTtsButton = (on: boolean): void => {
    setShowTtsButton(on);
    setTtsBtnOnState(on);
  };

  const pickWallpaperPreset = (id: string): void => {
    setWpNote("");
    if (id === "") {
      setWallpaper({ ...DEFAULT_WALLPAPER });
    } else {
      setWallpaper({ ...wallpaper, kind: "preset", preset: id, url: "" });
    }
    setWallpaperState(getWallpaper());
  };

  const patchWallpaper = (patch: Partial<WallpaperPref>): void => {
    setWallpaper({ ...wallpaper, ...patch });
    setWallpaperState(getWallpaper());
  };

  const pickLibraryWallpaper = (url: string): void => {
    setWpNote("");
    setWallpaper({ ...wallpaper, kind: "media", preset: "", url });
    setWallpaperState(getWallpaper());
  };

  /** 删收藏：壁纸引用只在本设备，文件直接删掉不留孤儿；删的是当前这张就退回无壁纸。 */
  const deleteLibraryWallpaper = (url: string): void => {
    removeWallpaperLibraryItem(url);
    setWallpaperLib(getWallpaperLibrary());
    if (wallpaper.kind === "media" && wallpaper.url === url) {
      setWallpaper({ ...DEFAULT_WALLPAPER, surface: wallpaper.surface });
      setWallpaperState(getWallpaper());
    }
    void wallpaperApi.removeWallpaperFile(url);
  };

  const onWallpaperFile = (): void => {
    const file = wpFileRef.current?.files?.[0];
    if (wpFileRef.current) wpFileRef.current.value = "";
    if (!file) return;
    const isImage = file.type.startsWith("image/");
    const isVideo = file.type === "video/mp4" || file.type === "video/webm";
    if (!isImage && !isVideo) {
      setWpNote("支持图片（png / jpg / webp / gif）或视频（mp4 / webm）。");
      return;
    }
    if (isImage && file.size > WP_IMAGE_MAX) {
      setWpNote(`图片太大了（${(file.size / 1024 / 1024).toFixed(1)}MB），需要在 5MB 以内。`);
      return;
    }
    if (isVideo && file.size > WP_VIDEO_MAX) {
      setWpNote(`视频太大了（${(file.size / 1024 / 1024).toFixed(0)}MB），需要在 100MB 以内。`);
      return;
    }
    setWpBusy(true);
    setWpNote("");
    wallpaperApi.uploadWallpaper(file)
      .then(({ url }) => {
        addWallpaperLibraryItem(url);
        setWallpaperLib(getWallpaperLibrary());
        setWallpaper({ ...wallpaper, kind: "media", preset: "", url });
        setWallpaperState(getWallpaper());
        setWpNote("");
      })
      .catch((e: unknown) => setWpNote(`没能设置：${e instanceof Error ? e.message : String(e)}`))
      .finally(() => setWpBusy(false));
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
      if (r.ok) { setStoreTarget(r.path); return; }
      // 取消选择器是正常操作：静默回来就行，不写提示。
      if ("error" in r) setStoreNote(r.error);
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

  /** 在系统文件管理器里定位刚保存的备份文件（桌面端才有真实路径）。 */
  const openSavedBackupFolder = (): void => {
    if (!savedBackupPath) return;
    void revealInFolder(savedBackupPath).then((r) => {
      if (!r.ok) setTransferError(r.error);
    });
  };

  const doExport = (): void => {
    if (exportBusy) return;
    setSavedBackupPath(null);
    if (dataTransferApi.isDesktopRuntime()) {
      nativeDownloadSeen.current = false;
      setExportBusy(true);
      setTransferInfo("正在生成备份，随后会保存到系统下载目录…", 5, true);
      dataTransferApi.startNativeBackupDownload();
      if (nativeDownloadTimer.current !== null) window.clearTimeout(nativeDownloadTimer.current);
      nativeDownloadTimer.current = window.setTimeout(() => {
        if (nativeDownloadSeen.current) return;
        setExportBusy(false);
        setTransferError("桌面下载没有启动，请重试；若仍失败，请重启应用后再试。");
      }, 20_000);
      return;
    }
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
        markBackupCompleted();
        setLastBackupAt(getLastBackupAt());
        setTransferOk(`备份已导出：${fileName}`, 100);
      })
      .catch((e: Error) => {
        if (e instanceof dataTransferApi.DirectDownloadStarted) {
          // 直链下载的结果页面看不到：可能成功，也可能服务端/网络真失败。
          // 所以只给提示、不拉满进度条，更不能显示成绿色“已导出”。
          setTransferInfo(e.message);
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
      <section className="settings-panel appearance-panel" id="settings-appearance">
        <div className="settings-panel-head">
          <h3>外观</h3>
          <p>一套稳定的产品视觉，只调整明暗与少量强调色。壁纸负责氛围，不再切换整套皮肤。</p>
        </div>

        <div className="settings-row">
          <div className="settings-row-label">
            <b>显示模式</b>
            <span>{wallpaperOn
              ? "界面正按壁纸自动适配配色；关闭壁纸后这里恢复生效。"
              : "「跟随系统」会随操作系统的深浅色自动切换。"}</span>
          </div>
          {wallpaperOn ? (
            <div className="mode-badge" role="status">
              <i aria-hidden="true" />
              壁纸适配中
            </div>
          ) : (
            <div className="choice-row" role="group" aria-label="显示模式">
              {MODES.map((m) => (
                <button key={m.key} type="button" className="choice" aria-pressed={mode === m.key}
                  onClick={() => pick(m.key)}>{m.label}</button>
              ))}
            </div>
          )}
        </div>

        <div className="settings-row">
          <div className="settings-row-label">
            <b>强调色</b>
            <span>只影响主按钮、选中态和少量重点信息，不改变页面材质。</span>
          </div>
          <div className="accent-picker" role="group" aria-label="强调色">
            {ACCENTS.map((a) => (
              <button key={a.label} type="button" className="accent-choice" aria-pressed={accent === a.hex}
                title={a.label} onClick={() => pickAccent(a.hex)}>
                <span className="accent-swatch" style={{ background: a.hex || "var(--brand-accent)" }} />
                <span>{a.label}</span>
              </button>
            ))}
            <label className="accent-custom" title="选择自定义强调色">
              <input type="color" value={accent || "#a64b2f"}
                aria-label="自定义强调色"
                onChange={(e) => pickAccent(e.target.value)} />
              <span className="accent-swatch accent-swatch-custom" />
              <span>自定义</span>
            </label>
          </div>
        </div>
      </section>

      <section className="settings-panel wallpaper-panel" id="settings-wallpaper">
        <div className="settings-panel-head">
          <h3>壁纸</h3>
          <p>壁纸是空间氛围的唯一来源。开启后界面自动进入壁纸适配：玻璃表面与专属配色一起生效，浅色 / 深色暂停。</p>
        </div>
        <div className="wp-grid" role="group" aria-label="壁纸">
          <button type="button" className="wp-thumb wp-thumb-off"
            aria-pressed={wallpaper.kind === "none"} onClick={() => pickWallpaperPreset("")}>
            <span className="wp-thumb-face" aria-hidden="true" />
            <span className="wp-thumb-label">无壁纸</span>
          </button>
          {WALLPAPER_PRESETS.map((p) => (
            <button key={p.id} type="button" className="wp-thumb" aria-pressed={wallpaper.kind === "preset" && wallpaper.preset === p.id}
              onClick={() => pickWallpaperPreset(p.id)}>
              {wallpaperPreset(p.id)
                ? <span className="wp-thumb-face" data-wp-preview={p.id} aria-hidden="true" />
                : <span className="wp-thumb-face" style={{ background: p.swatch }} aria-hidden="true" />}
              <span className="wp-thumb-label">{p.label}</span>
            </button>
          ))}
          {wallpaperLib.map((item) => {
            const isVideo = /\.(mp4|webm)$/i.test(item.url);
            const active = wallpaper.kind === "media" && wallpaper.url === item.url;
            return (
              <div key={item.url} className="wp-thumb-item">
                <button type="button" className="wp-thumb wp-thumb-lib" aria-pressed={active}
                  onClick={() => pickLibraryWallpaper(item.url)}>
                  {isVideo ? (
                    <video className="wp-thumb-face" src={item.url} muted playsInline preload="metadata" aria-hidden="true" />
                  ) : (
                    <img className="wp-thumb-face" src={item.url} alt="" aria-hidden="true" />
                  )}
                  <span className="wp-thumb-label">{isVideo ? "视频" : "图片"}</span>
                </button>
                <button type="button" className="wp-thumb-del" aria-label="删除这张壁纸" title="删除这张壁纸"
                  onClick={() => deleteLibraryWallpaper(item.url)}>
                  <X size={13} strokeWidth={2.4} aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>

        {wallpaper.kind !== "none" && (
          <div className="wp-slider-row">
            <label htmlFor="wp-surface">界面通透度</label>
            <input id="wp-surface" type="range" min={0} max={80} step={1} value={wallpaper.surface}
              onChange={(e) => patchWallpaper({ surface: Number(e.target.value) })} />
            <output>{wallpaper.surface}%</output>
          </div>
        )}

        <div className="settings-foot">
          <button type="button" className="btn sm" disabled={wpBusy} onClick={() => wpFileRef.current?.click()}>
            {wpBusy ? "正在上传…" : "上传图片 / 视频"}
          </button>
          <span className="hint">支持 PNG / JPG / WEBP / GIF / MP4 / WEBM</span>
          <input ref={wpFileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm"
            style={{ display: "none" }} onChange={onWallpaperFile} />
        </div>
        {wpNote && <div className="inline-note">{wpNote}</div>}
      </section>

      <section className="settings-panel" id="settings-chat-display">
        <div className="settings-panel-head">
          <h3>聊天显示</h3>
          <p>这些偏好只影响这台设备，不改动对话数据。</p>
        </div>

        <div className="settings-row">
          <div className="settings-row-label">
            <b>气泡时间</b>
            <span>{CLOCKS.find((c) => c.key === clock)?.hint}</span>
          </div>
          <div className="choice-row" role="group" aria-label="气泡时间">
            {CLOCKS.map((c) => (
              <button key={c.key} type="button" className="choice" aria-pressed={clock === c.key}
                title={c.hint} onClick={() => pickClock(c.key)}>{c.label}</button>
            ))}
          </div>
        </div>

        <div className="settings-row compact">
          <div className="settings-row-label">
            <b>生成速度</b>
            <span>回复气泡右下角显示这次的出字速度（t/s）。</span>
          </div>
          <div className="choice-row" role="group" aria-label="生成速度">
            <button type="button" className="choice" aria-pressed={!speedOn} onClick={() => pickSpeed(false)}>关闭</button>
            <button type="button" className="choice" aria-pressed={speedOn} onClick={() => pickSpeed(true)}>开启</button>
          </div>
        </div>

        <div className="settings-row compact">
          <div className="settings-row-label">
            <b>语音播放按钮</b>
            <span>回复气泡右下角的 🔊 按钮，点了会把这条回复读出来；关掉不影响语音能力。</span>
          </div>
          <div className="choice-row" role="group" aria-label="语音播放按钮">
            <button type="button" className="choice" aria-pressed={!ttsBtnOn} onClick={() => pickTtsButton(false)}>关闭</button>
            <button type="button" className="choice" aria-pressed={ttsBtnOn} onClick={() => pickTtsButton(true)}>开启</button>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-label">
            <b>列表密度</b>
            <span>管理类清单每页显示多少条。</span>
          </div>
          <div className="choice-row" role="group" aria-label="列表每页">
            {LIST_PAGE_SIZES.map((n) => (
              <button key={n} type="button" className="choice" aria-pressed={listPage === n}
                onClick={() => { setListPageSize(n); setListPage(n); }}>{LIST_PAGE_LABEL[n]}</button>
            ))}
          </div>
        </div>
      </section>

      <section className="settings-panel" id="settings-notifications">
        <div className="settings-panel-head">
          <h3>消息提醒</h3>
          <p>后台收到新消息时发送系统通知；点击通知会回到对应会话。</p>
        </div>
        <div className="settings-row compact">
          <div className="settings-row-label">
            <b>系统通知</b>
            <span>{notifyNote || (notificationSupported() ? "权限由系统管理，可随时关闭。" : "当前环境不支持系统通知。")}</span>
          </div>
          <div className="choice-row" role="group" aria-label="消息提醒">
            <button type="button" className="choice" aria-pressed={!notifyOn}
              disabled={!notificationSupported()} onClick={() => toggleNotify(false)}>关闭</button>
            <button type="button" className="choice" aria-pressed={notifyOn}
              disabled={!notificationSupported()} onClick={() => toggleNotify(true)}>开启</button>
          </div>
        </div>
      </section>

        </>
      )}

      {scope === "system" && (
        <div className="system-settings">
      <section className="settings-panel privacy-panel" id="settings-privacy">
        <div className="settings-panel-head">
          <h3>隐私与数据边界</h3>
          <p>先确认数据在哪里、什么时候会出网。这里只展示事实，不会修改任何内容。</p>
        </div>
        <div className="privacy-boundary">
          <div><b>保存在本机</b><span>{dataDir || "应用数据目录"}</span></div>
          <div><b>调用模型时会发送</b><span>当前对话、召回到的长期记忆、人设与本轮必要工具说明</span></div>
          <div><b>不会自动发送</b><span>其它联系人的聊天与记忆不会串入这次调用；本地数据目录不会整体上传</span></div>
          <div><b>API Key</b><span>只用于向所配置的服务商鉴权，不作为聊天内容保存或发送给其他服务商</span></div>
          <div><b>最近备份</b><span>{lastBackupAt ? new Date(lastBackupAt).toLocaleString("zh-CN") : "还没有在本机导出过备份"}</span></div>
        </div>
        <div className="settings-foot">
          <DiagnosticsButton className="btn sm" onAction={(action) => {
            if (action === "backup") document.getElementById("settings-backup")?.scrollIntoView({ behavior: "smooth", block: "start" });
            else if (action === "storage") document.getElementById("settings-storage")?.scrollIntoView({ behavior: "smooth", block: "start" });
            else if (action === "activity") window.location.hash = "#/status";
            else if (action === "settings") document.getElementById("settings-privacy")?.scrollIntoView({ behavior: "smooth", block: "start" });
          }} />
          <span className="hint">只读检查数据库、回复任务与媒体文件。</span>
        </div>
      </section>

      <section className="settings-panel" id="settings-storage">
        <div className="settings-panel-head">
          <h3>数据存储</h3>
          <p>对话、记忆、图片、视频、语音、技能和设置都保存在本机。迁移目录时会把现有数据一起搬过去。</p>
        </div>
        <div className="settings-row compact">
          <div className="settings-row-label">
            <b>当前位置</b>
            <span style={{ wordBreak: "break-all" }}><code>{dataDir || "（跟随项目 data 目录）"}</code></span>
          </div>
          <button type="button" className="btn sm" disabled={storeBusy} onClick={chooseFolder}>选择文件夹</button>
        </div>
        <div className="settings-row compact">
          <div className="settings-row-label">
            <b>占用与清理</b>
            <span>查看数据库、诊断原文、调用记录和导入前备份；不包含聊天消息与长期记忆。</span>
          </div>
          <button type="button" className="btn sm" onClick={() => setStorageOpen(true)}>数据清理</button>
        </div>
        <div className="settings-row compact">
          <div className="settings-row-label">
            <b>图片、视频与语音</b>
            <span>统一查看聊天媒体、可清理文件与回收站；语音消息跟随聊天记录保存。</span>
          </div>
          <button type="button" className="btn sm" onClick={() => setMediaOpen(true)}>媒体与存储</button>
        </div>
        {storeNote && <div className="inline-note">{storeNote}</div>}
      </section>

      <section className="settings-panel" id="settings-backup">
        <div className="settings-panel-head">
          <h3>备份与恢复</h3>
          <p>导出包包含对话、记忆、联系人、模型设置、图片、视频、语音与技能，也包含已保存的 API Key，只通过可信方式传输。</p>
        </div>
        <div className="settings-foot">
          <button type="button" className="btn sm" disabled={exportBusy} onClick={doExport}>
            {exportBusy ? "正在导出…" : "导出备份"}
          </button>
          <a className="btn sm" href={dataTransferApi.EXPORT_URL} download onClick={(event) => {
            if (!dataTransferApi.isDesktopRuntime()) return;
            event.preventDefault();
            doExport();
          }}>直接下载</a>
          <button type="button" className="btn sm" disabled={transferBusy} onClick={pickImport}>
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
            {savedBackupPath && (
              <button type="button" className="btn sm" onClick={openSavedBackupFolder}>
                在文件夹中打开
              </button>
            )}
          </div>
        )}
      </section>

      <LanSection />

      {desktop !== null && (
        <section className="settings-panel" id="settings-desktop">
          <div className="settings-panel-head">
            <h3>启动与关窗</h3>
            <p>决定小茉是否在登录系统后自动启动，以及关闭窗口后是否继续在托盘运行。</p>
          </div>

          <div className="settings-row">
            <div className="settings-row-label">
              <b>开机自动启动</b>
              <span>登录系统后自动打开小茉。</span>
            </div>
            <div className="choice-row" role="group" aria-label="开机自动启动">
              <button type="button" className="choice" aria-pressed={!prefs.autostart}
                onClick={() => toggleDesktop("autostart", false)}>关闭</button>
              <button type="button" className="choice" aria-pressed={prefs.autostart}
                onClick={() => toggleDesktop("autostart", true)}>开启</button>
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row-label">
              <b>托盘常驻</b>
              <span>开启后，关闭窗口只是收进托盘；需从托盘菜单主动退出。</span>
            </div>
            <div className="choice-row" role="group" aria-label="托盘常驻">
              <button type="button" className="choice" aria-pressed={!prefs.tray}
                onClick={() => toggleDesktop("tray", false)}>关闭</button>
              <button type="button" className="choice" aria-pressed={prefs.tray}
                onClick={() => toggleDesktop("tray", true)}>开启</button>
            </div>
          </div>

          {prefsNote !== "" && <div className="inline-note">{prefsNote}</div>}
        </section>
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

      {mediaOpen && (
        <MediaMaintenanceDialog
          onBack={() => setMediaOpen(false)}
          onClose={() => setMediaOpen(false)}
          onChanged={() => {}}
        />
      )}

      {storageOpen && <StorageCleanupDialog onClose={() => setStorageOpen(false)} />}
        </div>
      )}
    </>
  );
}



