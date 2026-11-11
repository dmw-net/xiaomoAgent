import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AudioLines, ChevronDown, File, Film, FolderInput, FolderOpen, Image as ImageIcon, ImageOff, MessageCircle, Pencil, Search, Shapes, Smile, Sparkles, Star, Trash2, Upload, User, X } from "lucide-react";
import { artifactApi, assetsApi, contactsApi, emotesApi, type Asset, type AssetKindFilter, type AssetView, type EmoteNamedFilter, type EmotePackCount, type NamingJob, type NamingStats } from "../api";
import { pickDirectory } from "../lib/native-dialog";
import EmoteSemanticsModal from "./EmoteSemanticsModal";
import EmptyState from "./EmptyState";
import ListPager from "./ListPager";
import Modal from "./Modal";
import VoiceMessageBubble from "./VoiceMessageBubble";
import ToggleSwitch from "./ToggleSwitch";
import { revealInFolder } from "../lib/reveal-folder";
import { usePagedList } from "../hooks/usePagedList";
import { useDismiss } from "../hooks/useDismiss";
import type { PanelAria } from "./Tabs";

/**
 * 媒体库：联系人有过、收到过、画过的东西都在这一页——全站唯一的媒体浏览页。
 * 列一批 /media 文件，能搜能筛能预览能删；视角是参数：
 * 「表情包」「收藏」「作品」「聊天」「和某人」都是这一页上的一个筛选条件。
 *
 * 不含媒体维护弹窗：它管回收站 / 恢复 / 彻底删除，是存储运维，不是内容浏览。
 */

const VIEWS: Array<{ key: AssetView; label: string; hint: string }> = [
  { key: "all", label: "全部", hint: "发过、收到过、画过的都在这里" },
  { key: "emote", label: "表情包", hint: "聊天时可随手发出的表情包素材" },
  { key: "starred", label: "收藏", hint: "你标过星的那些" },
  { key: "generated", label: "作品", hint: "画出来的图" },
  { key: "chat", label: "聊天", hint: "对话里发来发去的图片、视频与语音" },
];

const KINDS: Array<{ key: AssetKindFilter; label: string; hint: string }> = [
  { key: "all", label: "全部类型", hint: "不限制类型" },
  { key: "image", label: "图片", hint: "照片、梗图、生成的图" },
  { key: "video", label: "视频", hint: "短片与动图视频" },
  { key: "audio", label: "语音", hint: "可直接播放的语音" },
  { key: "file", label: "文件", hint: "无法内联预览的其它附件" },
];

const KIND_LABELS: Record<Asset["kind"], string> = { image: "图片", video: "视频", audio: "语音", file: "文件" };

/** 「在文件管理器中显示」只在桌面端出现：浏览器（含局域网访问）里没有外壳，不留假按钮。 */
const DESKTOP = "__TAURI_INTERNALS__" in window;

/** 表情根目录名，与后端 media-layout 的 EMOTE_ROOT 同词。 */
const EMOTE_ROOT = "表情包";

/** 路径最后一段＝导入回执里说的文件夹名。与后端 folderNameOf 同口径。 */
const baseName = (path: string): string => path.trim().split(/[\\/]/).filter(Boolean).pop() ?? "";

/** 命名状态筛选。计数的真源是 /api/assets 的 naming，不在前端另算一遍。 */
const NAMED_FILTERS: Array<{ key: EmoteNamedFilter; label: string; hint: string }> = [
  { key: "unnamed", label: "未命名", hint: "还没有名称，对话中检索不到这些" },
  { key: "file", label: "文件命名", hint: "导入文件夹时从文件名直接读取，没有调用图片理解模型" },
  { key: "auto", label: "智能识别", hint: "由图片理解模型识别出来的名字" },
  { key: "manual", label: "手动维护", hint: "你在语义卡里手写或改过的名字（重新识别会覆盖它们）" },
];

/** 来源的中文说法。unclaimed 不叫「未知」——对用户来说它是「还没归类的东西」，别用系统词。 */
const SOURCE_LABELS: Record<string, string> = {
  unclaimed: "还没归类", upload: "你上传的", chat: "聊天里的", generated: "画出来的",
  imported: "导入的", captured: "收到过的", avatar: "头像", face_ref: "长相参考",
  wallpaper: "壁纸", tool: "工具产出",
};

/** 内容时间：今天只显时分，其余给到日期——这一页按时间翻，信息要够扫。 */
function whenOf(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

function durationLabel(ms?: number): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "";
  const total = Math.max(1, Math.round(ms / 1000));
  return `${Math.floor(total / 60) > 0 ? Math.floor(total / 60) + "分" : ""}${total % 60}秒`;
}

/** 卡片标题：作品提示词优先，其次表情名，再次出处消息的文字；都没有就报类型。 */
function titleOf(a: Asset): string {
  const prompt = a.detail.prompt.trim();
  if (prompt !== "") return prompt;
  if (a.emoteLabel !== "") return a.emoteLabel;
  if (a.kind === "audio" && a.detail.transcript !== "") return a.detail.transcript;
  const text = a.detail.originText.trim().slice(0, 60);
  if (text !== "") return text;
  return KIND_LABELS[a.kind];
}

function emptyCopyFor(view: AssetView, kind: AssetKindFilter, who: string): string {
  if (kind !== "all") return `这一类里还没有${KIND_LABELS[kind as Asset["kind"]] ?? KIND_LABELS.image}。`;
  if (view === "emote") return "还没有表情包素材。点上方「导入文件夹」整批加，或「上传图片」单张加；也可以点任意卡片上的笑脸。加完点「智能识别」生成名称。";
  if (view === "starred") return "还没有收藏。点卡片上的星标，常看的会留在这里。";
  if (view === "generated") return `还没有作品。配置图像生成后，让${who}画一张试试。`;
  if (view === "chat") return "还没有聊天内容。对话里发送或收到的图片、视频与语音会自动出现在这里。";
  return "这里还是空的。收到过的、画出的、发过的图都会按时间出现在这一页。";
}

type FilterMenuOption<T extends string> = {
  value: T;
  label: string;
  count?: number;
  disabled?: boolean;
};

/** 统一的自定义下拉：不用原生 select，箭头、文字和计数各有自己的位置。 */
function FilterMenu<T extends string>({
  label, value, options, onChange, className = "",
}: {
  label: string;
  value: T;
  options: FilterMenuOption<T>[];
  onChange: (value: T) => void;
  className?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<{ horizontal: "left" | "right"; vertical: "down" | "up" }>({
    horizontal: "left", vertical: "down",
  });
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useDismiss(open, () => setOpen(false), rootRef);
  const current = options.find((option) => option.value === value);

  const toggle = (): void => {
    if (open) { setOpen(false); return; }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect !== undefined) {
      const popupWidth = 230;
      const popupHeight = Math.min(300, options.length * 34 + 12);
      setPlacement({
        horizontal: rect.left + popupWidth > window.innerWidth - 12 ? "right" : "left",
        vertical: window.innerHeight - rect.bottom < popupHeight + 12 && rect.top > popupHeight + 12 ? "up" : "down",
      });
    }
    setOpen(true);
  };

  return (
    <div className={("ml-menu " + className).trim()} ref={rootRef}>
      <button ref={buttonRef} type="button" className={"ml-select ml-menu-btn" + (open ? " open" : "")}
        aria-haspopup="listbox" aria-expanded={open}
        aria-label={`${label}筛选，当前${current?.label ?? "全部"}`}
        onClick={toggle}>
        <span className="ml-menu-label">{label}</span>
        <span className="ml-menu-value">{current?.label ?? "全部"}</span>
        {current?.count !== undefined && <span className="content-count">{current.count}</span>}
        <ChevronDown size={12} className="ml-menu-caret" aria-hidden="true" />
      </button>
      {open && (
        <div className={"ml-menu-pop " + placement.horizontal + " " + placement.vertical} role="listbox" aria-label={label}>
          {options.map((option) => (
            <button key={option.value} type="button" role="option" aria-selected={option.value === value}
              className={"ml-menu-opt" + (option.value === value ? " on" : "")}
              disabled={option.disabled === true}
              onClick={() => { if (option.disabled === true) return; onChange(option.value); setOpen(false); }}>
              <span className="ml-menu-opt-label">{option.label}</span>
              {option.count !== undefined && <span className="content-count">{option.count}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function MediaLibrary({
  active = true, contactId = "", who = "该联系人", faceRef = "", onFaceRefChanged, panel, initialView = "all", title, refreshKey = 0,
}: {
  active?: boolean;
  /** 给了就是「和某人」视角，不给是全库。 */
  contactId?: string;
  who?: string;
  faceRef?: string;
  onFaceRefChanged?: (url: string) => void;
  panel?: PanelAria;
  initialView?: AssetView;
  /** 卡片容器上的标题；嵌在别的分区里时可以不传。 */
  title?: string;
  /** 变了就重画：外部（上传完、导入完）用它把列表拉新。 */
  refreshKey?: number;
}): JSX.Element {
  const [view, setView] = useState<AssetView>(initialView);
  const [kind, setKind] = useState<AssetKindFilter>("all");
  const [pack, setPack] = useState("");
  const [named, setNamed] = useState<EmoteNamedFilter>("any");
  const [missingOnly, setMissingOnly] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);
  const [bulkBusy, setBulkBusy] = useState<"" | "star" | "moveEmote">("");
  const [bulkDone, setBulkDone] = useState(0);
  const [bulkMoveOpen, setBulkMoveOpen] = useState(false);
  const [bulkMoveTarget, setBulkMoveTarget] = useState("");
  const [bulkMoveQuery, setBulkMoveQuery] = useState("");
  const selectionSeqRef = useRef(0);
  const [packOpen, setPackOpen] = useState(false);
  const [packUp, setPackUp] = useState(false);
  const [packQuery, setPackQuery] = useState("");
  const [showResults, setShowResults] = useState(false);
  const packRef = useRef<HTMLDivElement>(null);
  useDismiss(packOpen, () => setPackOpen(false), packRef);
  const [query, setQuery] = useState("");
  // 动作反馈只有一个出口：底部轻提示。成功深色、失败红色——和聊天页同一套，
  // 不再往页面里插整行红框/灰条（它们把搜索和概览条之间的距离撑得忽大忽小）。
  const [toast, setToast] = useState<{ text: string; tone: "info" | "warn" } | null>(null);
  const setNotice = (text: string): void => setToast(text === "" ? null : { text, tone: "info" });
  const setErr = (text: string): void => setToast(text === "" ? null : { text, tone: "warn" });
  const [busyId, setBusyId] = useState("");
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [kindCounts, setKindCounts] = useState<Record<AssetKindFilter, number>>({
    all: 0, image: 0, video: 0, audio: 0, file: 0,
  });
  const [naming, setNaming] = useState<NamingStats>({ total: 0, named: 0, auto: 0, manual: 0, file: 0 });
  const [packs, setPacks] = useState<EmotePackCount[]>([]);
  const [mediaDir, setMediaDir] = useState("");
  const [broken, setBroken] = useState(0);
  const [job, setJob] = useState<NamingJob | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  const [edit, setEdit] = useState<Asset | null>(null);
  const [confirmDel, setConfirmDel] = useState<Asset | null>(null);
  useDismiss(!!zoom, () => setZoom(null));

  // 选择模式是一个显式状态：浏览时不铺满复选框，退出时一次收起。
  useEffect(() => {
    if (!selectionMode) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setSelected(new Set());
      setSelectionMode(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectionMode]);

  // 筛选条件一换，旧选择就不该继续偷偷参与批量操作；正在跑的全选请求也一并作废。
  useEffect(() => {
    selectionSeqRef.current += 1;
    setSelected(new Set());
    setSelectionMode(false);
    setSelectingAll(false);
  }, [contactId, view, kind, pack, named, missingOnly, query]);

  const fetchPage = useCallback((limit: number, offset: number) =>
    assetsApi.listAssets({ view, kind, q: query, pack, named, missing: missingOnly, contactId, limit, offset }).then((d) => {
      setCounts(d.counts);
      setKindCounts(d.kindCounts);
      setNaming(d.naming);
      setPacks(d.packs);
      setMediaDir(d.mediaDir);
      setBroken(d.stats.broken ?? 0);
      return { rows: d.items, total: d.total };
    }), [view, kind, query, pack, named, missingOnly, contactId]);
  const list = usePagedList<Asset>(fetchPage, {
    key: contactId + ":" + view + ":" + kind + ":" + pack + ":" + named + ":" + missingOnly + ":" + query + ":" + refreshKey,
    enabled: active,
  });

  const wasActiveRef = useRef(active);
  useEffect(() => {
    const wake = active && !wasActiveRef.current;
    wasActiveRef.current = active;
    if (wake) list.reset();
  }, [active, list]);

  const chooseView = (next: AssetView): void => { setView(next); setKind("all"); setPack(""); setNamed("any"); setMissingOnly(false); setNotice(""); setErr(""); setPackOpen(false); };
  const chooseKind = (next: AssetKindFilter): void => { setKind(next); setNotice(""); setErr(""); };

  // 下拉最高约 400px（搜索框 + 260px 列表 + 说明）：下方放不下且上方放得下就向上翻，
  // 否则整块弹窗落在折叠线外，用户以为点了没反应。
  const togglePack = (): void => {
    if (!packOpen) {
      const r = packRef.current?.getBoundingClientRect();
      setPackUp(r !== undefined && window.innerHeight - r.bottom < 400 && r.top > 400);
    }
    setPackOpen(!packOpen);
  };

  // ── 智能识别：逐张调用图片理解模型，生成名称与用法说明 ──────────────
  // 作业在后端跑（一次图片理解调用一张），界面只轮询这一个状态；跑完把列表拉新，
  // 因为名称是这批作业唯一的产出，不拉新就等于让人以为没变。
  const [polling, setPolling] = useState(false);

  // 页面重新打开时先把后台任务接回来：运行中继续轮询，已结束也保留上一轮结果。
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    emotesApi.namingStatus()
      .then((d) => {
        if (cancelled) return;
        setJob(d.job);
        setNaming(d.naming);
        if (d.job.running) setPolling(true);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [active]);

  useEffect(() => {
    if (!polling) return;
    const timer = window.setInterval(() => {
      emotesApi.namingStatus()
        .then((d) => {
          setJob(d.job); setNaming(d.naming);
          if (!d.job.running) {
            setPolling(false);
            // 用完成回执替换启动文案；切到别的视角时也能知道后台任务已经结束。
            const handled = d.job.named + d.job.failed;
            setNotice(handled > 0
              ? `智能识别完成：成功 ${d.job.named} 张${d.job.failed > 0 ? `，失败 ${d.job.failed} 张` : ""}。`
              : "");
          }
        })
        .catch(() => setPolling(false));
    }, 1200);
    return () => window.clearInterval(timer);
  }, [polling]);

  const wasRunningRef = useRef(false);
  useEffect(() => {
    const running = job?.running === true;
    if (wasRunningRef.current && !running) list.reset();
    wasRunningRef.current = running;
  }, [job, list]);

  // 操作回执是轻提示：浮层停留几秒自己撤，不占排版、不把下面的内容顶来顶去。
  // 失败比成功多停 2 秒——人要把错误读完，成功只需要扫一眼。
  useEffect(() => {
    if (toast === null) return;
    const ms = toast.tone === "warn" ? 6000 : 4000;
    const t = window.setTimeout(() => setToast(null), ms);
    return () => window.clearTimeout(t);
  }, [toast]);

  const runNaming = async (options: { force?: boolean; only?: string[] } = {}): Promise<void> => {
    setErr(""); setNotice("");
    // 起跑前是否在跑，决定这句回执怎么说：往正在跑的作业后面追加，不该报成「新起了一轮」。
    const wasRunning = job?.running === true;
    try {
      const d = await emotesApi.startNaming(options);
      setJob(d.job);
      setNaming(d.naming);
      if (d.job.running) {
        setPolling(true);
        setNotice(!wasRunning
          ? `已开始智能识别，共 ${d.job.total} 张（后台运行）。`
          : d.queued > 0
            ? `已排进当前任务，队列里共 ${d.job.total} 张。`
            : "这些张已经在队列里了，不重复识别。");
      } else if (!d.started) {
        setNotice(d.reason ?? "任务未启动。");
      }
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
    }
  };

  /** 只重试本轮失败的那几张：整库跑完还剩三五张时，不该让人再点一次「识别全部」。 */
  const retryFailed = async (): Promise<void> => {
    const ids = (job?.results ?? []).filter((r) => r.error !== "").map((r) => r.id);
    if (ids.length === 0) return;
    await runNaming({ only: ids });
  };

  // ── 添加：表情包视角自带入口（上传/导入/自动收录），不再在页头顶一张突兀的大卡片 ──
  const [adding, setAdding] = useState("");
  const [autoCapture, setAutoCapture] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (contactId === "") emotesApi.overview().then((d) => setAutoCapture(d.autoCapture === true)).catch(() => {});
  }, [contactId]);
  const onPickFile = (file: File | undefined): void => {
    if (file === undefined) return;
    setAdding("upload");
    emotesApi.upload(file)
      .then(() => { setNotice("已加入。这张还未命名——点「智能识别」补个名字，聊天时才能找到它。"); list.reset(); })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => { setAdding(""); if (fileRef.current) fileRef.current.value = ""; });
  };
  const onImportDir = async (): Promise<void> => {
    const picked = await pickDirectory();
    // 取消选择器是正常操作：静默回来就行，弹红条会把「我没做完」渲染成「出了故障」。
    if (!picked.ok) { if ("error" in picked) setErr(picked.error); return; }
    setAdding("import");
    emotesApi.importDir(picked.path)
      .then((r) => {
        const folder = baseName(picked.path);
        const dropped = r.skippedFiles.slice(0, 3).map((f) => `${f.name}（${f.reason}）`).join("、");
        const tail = r.skipped > 0
          ? `；${r.skipped} 张没进来${dropped === "" ? "" : `：${dropped}${r.skippedFiles.length > 3 ? "…" : ""}`}`
          : "";
        // 少图是要人逐条核对的（超上限、格式读不出都得看见文件名），走 warn 那一档多停 2 秒；
        // 但文案先讲"已导入"，不把部分成功渲染成故障。
        if (r.skipped > 0) setErr(`已导入 ${r.added} 张到「${folder}」${tail}。`);
        else setNotice(`已导入 ${r.added} 张到「${folder}」。未命名的点「智能识别」补名。`);
        list.reset();
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setAdding(""));
  };
  const toggleCapture = (on: boolean): void => {
    setAdding("pref");
    emotesApi.setAutoCapture(on)
      .then((r) => { setAutoCapture(r.autoCapture === true); setNotice(on ? "开了：聊天里收到的图会自动入库。" : "已关闭。"); })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setAdding(""));
  };

  /** 在文件管理器里定位这个文件：绝对路径 = 媒体目录 + 库记的相对位置。
   *  打开失败多半意味着文件刚被人删了——就地验真：标失效、刷新列表，「清理此项」当场出现，
   *  而不是让人对着一句 path doesn't exist 自己猜（失效标记原本要等下一轮对账才刷新）。 */
  const revealAsset = (a: Asset): void => {
    if (mediaDir === "") { setErr("还没拿到媒体目录路径，刷新一下再试"); return; }
    const sep = mediaDir.includes("\\") ? "\\" : "/";
    const rel = (a.relPath !== "" ? a.relPath : a.url.slice("/media/".length)).split("/").join(sep);
    revealInFolder(mediaDir + sep + rel).then(async (r) => {
      if (r.ok) return;
      const probe = await assetsApi.assetAction("probeMissing", a.id);
      if (probe.ok && probe.marked === true) {
        setErr("原图已不在磁盘上：这张已标为失效，点卡片上的垃圾桶即可清理。");
        list.reset();
      } else {
        setErr(r.error ?? "没能打开文件夹");
      }
    });
  };

  /** 文件夹就是磁盘真目录：行内按钮打开对应目录。往里丢图，应用会自动认领。 */
  const openFolderNamed = (rel: string): void => {
    if (mediaDir === "") { setErr("还没拿到媒体目录路径，刷新一下再试"); return; }
    const sep = mediaDir.includes("\\") ? "\\" : "/";
    revealInFolder(mediaDir + sep + rel.split("/").join(sep)).then((r) => { if (!r.ok) setErr(r.error); });
  };

  const saveSemantics = async (patch: { label: string; caption: string; tags: string[]; pack: string[] }): Promise<void> => {
    if (edit === null) return;
    const r = await assetsApi.assetAction("editEmote", edit.id, patch);
    if (r.ok === false) throw new Error(r.error ?? "保存没成功");
    setNotice("已保存，之后按这个名称检索这张表情。");
    list.reset();
  };

/** 弹窗里那颗「智能识别」：排进当前队列，等这一张的结果行出现（不另起一条作业，
 *  所以整库跑着时它排在后面，进度条和「查看进度」都看得见它）。
 *  关窗不打断——作业在后台跑，状态条接着显示；这里只是不再回填。 */
const jobRef = useRef<NamingJob | null>(null);
useEffect(() => { jobRef.current = job; }, [job]);
const [renameHint, setRenameHint] = useState("");
const renameOne = async (): Promise<{ label: string; caption: string; tags: string[] } | null> => {
  if (edit === null) return null;
  const id = edit.id;
  let running = true;
  try {
    const d = await emotesApi.startNaming({ only: [id], force: true });
    setJob(d.job); setNaming(d.naming);
    if (!d.started) throw new Error(d.reason ?? "任务未启动。");
    running = d.job.running;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      const j = await emotesApi.namingStatus();
      setJob(j.job); setNaming(j.naming);
      running = j.job.running;
      const line = j.job.results.find((r) => r.id === id);
      if (line !== undefined) {
        if (line.error !== "") throw new Error(line.error);
        list.reset();
        return { label: line.name, caption: line.caption, tags: line.tags };
      }
      if (!j.job.running) throw new Error("这一张没有识别结果，再点一次「智能识别」。");
      const ahead = Math.max(0, j.job.total - j.job.done - 1);
      setRenameHint(ahead > 0 ? `排队中，前面还有 ${ahead} 张` : `正在识别这一张（${j.job.done}/${j.job.total}）`);
    }
  } catch (error) {
    throw error instanceof Error ? error : String(error);
  } finally {
    if (running) setPolling(true); else setRenameHint("");
  }
};

  /** 一次动作：乐观失败要如实显示，不静默。 */
  const act = async (a: Asset, op: "markEmote" | "unmarkEmote" | "dropMissing" | "star" | "unstar"): Promise<void> => {
    setErr(""); setBusyId(a.id);
    try {
      const r = await assetsApi.assetAction(op, a.id);
      if (r.ok === false) throw new Error(r.error ?? "操作没成功");
      setNotice(op === "markEmote"
        // 未命名的表情其实还检索不到：勾上之后要立刻说清下一步，而不是让人以为已经生效了。
        ? (a.emoteLabel === ""
          ? "已加入。这张还未命名——在「表情包」里点「智能识别」或手动填写名称，否则对话中检索不到它。"
          : "好了，聊天时能用上这张。")
        : op === "unmarkEmote" ? "已移出表情包。"
        : op === "dropMissing" ? "已清理这条失效记录。文件放回后会自动重新登记。" : "");
      list.reset();
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId("");
    }
  };

  const setFaceReference = async (a: Asset): Promise<void> => {
    if (contactId === "") return;
    setErr(""); setBusyId(a.id);
    try {
      await contactsApi.updateContact(contactId, { faceRef: a.url });
      setNotice("已设为自拍参考；后续自拍会优先按这张脸生成。");
      onFaceRefChanged?.(a.url);
      window.dispatchEvent(new Event("xiaomo:contacts-changed"));
      list.reset();
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId("");
    }
  };

  const deleteArtifact = async (a: Asset): Promise<void> => {
    if (a.detail.artifactId === "") return;
    setErr(""); setBusyId(a.id);
    try {
      await artifactApi.manageArtifact("delete", a.detail.artifactId, contactId);
      list.reset();
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId("");
    }
  };

  const rows = list.page?.rows ?? [];
  const selectedIds = [...selected];
  const totalInScope = list.page?.total ?? 0;
  const allFilteredSelected = totalInScope > 0 && selected.size === totalInScope;
  const toggleSelected = (id: string): void => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  /** 全选不是只选屏幕上的 25 张：按当前筛选翻完接口，拿到全部 id 后再一次选中。 */
  const selectAllFiltered = async (): Promise<void> => {
    if (totalInScope === 0 || selectingAll) return;
    setSelectionMode(true);
    const seq = selectionSeqRef.current;
    setSelectingAll(true);
    setErr("");
    try {
      const ids = new Set<string>();
      for (let offset = 0; offset < totalInScope; offset += 100) {
        const d = await assetsApi.listAssets({
          view, kind, q: query, pack, named, missing: missingOnly, contactId, limit: 100, offset,
        });
        for (const a of d.items) ids.add(a.id);
        if (d.items.length === 0) break;
      }
      if (selectionSeqRef.current !== seq) return;
      setSelected(ids);
      setNotice(`已选中当前筛选下的全部 ${ids.size} 张。`);
    } catch (error) {
      if (selectionSeqRef.current === seq) setErr(error instanceof Error ? error.message : String(error));
    } finally {
      if (selectionSeqRef.current === seq) setSelectingAll(false);
    }
  };
  const runSelectedNaming = async (): Promise<void> => {
    if (selectedIds.length === 0) return;
    // only 已经限定到勾选集合；force 让已有点击名也能重认，否则后台会按「已命名」跳过。
    await runNaming({ only: selectedIds, force: true });
  };

  /** 收藏/移动是本地资产操作：分小批并发，522 张也不会一次性打满服务端。 */
  const runBulkAssetAction = async (
    op: "star" | "moveEmote",
    extra?: { pack?: string[] },
  ): Promise<void> => {
    const ids = [...selected];
    if (ids.length === 0 || bulkBusy !== "") return;
    setBulkBusy(op);
    setBulkDone(0);
    setErr("");
    const failed: string[] = [];
    const chunkSize = 12;
    try {
      for (let offset = 0; offset < ids.length; offset += chunkSize) {
        const chunk = ids.slice(offset, offset + chunkSize);
        const results = await Promise.allSettled(
          chunk.map((id) => assetsApi.assetAction(op, id, extra)),
        );
        results.forEach((result, index) => {
          if (result.status === "rejected" || result.value.ok === false) failed.push(chunk[index]!);
        });
        setBulkDone(Math.min(ids.length, offset + chunk.length));
      }
      list.reset();
      if (failed.length > 0) {
        setSelected(new Set(failed));
        setSelectionMode(true);
        setErr(`${ids.length - failed.length} 张已处理，${failed.length} 张失败。失败项已保留选中。`);
      } else {
        const target = extra?.pack?.[0] ?? "";
        setSelected(new Set());
        setSelectionMode(false);
        setNotice(op === "star"
          ? `已收藏 ${ids.length} 张表情。`
          : `已把 ${ids.length} 张表情移到「${target}」。`);
      }
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
    } finally {
      setBulkBusy("");
    }
  };

  const openBulkMove = (): void => {
    const firstOther = packs.find((p) => p.pack !== pack)?.pack;
    setBulkMoveTarget(firstOther ?? packs[0]?.pack ?? "默认");
    setBulkMoveQuery("");
    setBulkMoveOpen(true);
  };
  const activeView = VIEWS.find((v) => v.key === view) ?? VIEWS[0]!;
  // 选中文件夹时，命名状态 chips 的数字跟着文件夹走：全库数字不随筛选变，
  // 否则空网格 + 不动的数字会被读成「筛选坏了」。
  const packRow = pack === "" ? undefined : packs.find((p) => p.pack === pack);
  const scopeCounts = packRow === undefined
    ? { unnamed: naming.total - naming.named, file: naming.file, auto: naming.auto, manual: naming.manual }
    : { unnamed: packRow.unnamed, file: packRow.file, auto: packRow.auto, manual: packRow.manual };
  const scopeTotal = packRow?.total ?? naming.total;
  const namedOptions: FilterMenuOption<EmoteNamedFilter>[] = [
    { value: "any", label: "全部", count: scopeTotal },
    ...NAMED_FILTERS.map((f) => ({
      value: f.key,
      label: f.label,
      count: f.key === "unnamed" ? scopeCounts.unnamed
        : f.key === "file" ? scopeCounts.file
          : f.key === "auto" ? scopeCounts.auto : scopeCounts.manual,
    })),
  ];
  const kindOptions: FilterMenuOption<AssetKindFilter>[] = KINDS.map((f) => ({
    value: f.key,
    label: f.label,
    count: kindCounts[f.key] ?? 0,
    disabled: f.key !== "all" && (kindCounts[f.key] ?? 0) === 0,
  }));
  const moveFolders = Array.from(new Set(["默认", ...packs.map((p) => p.pack)])).filter(Boolean);
  const activeFilters: string[] = [];
  if (query.trim() !== "") activeFilters.push(`“${query.trim()}”`);
  if (view === "emote" && named !== "any") {
    activeFilters.push(NAMED_FILTERS.find((f) => f.key === named)?.label ?? named);
  }
  if (view === "emote" && pack !== "") activeFilters.push(`文件夹「${pack}」`);
  if (view === "emote" && missingOnly) activeFilters.push("仅失效");
  if (kind !== "all") activeFilters.push(KIND_LABELS[kind as Asset["kind"]] ?? kind);
  const activeFilterChips: Array<{ key: string; label: string; clear: () => void }> = [];
  if (view === "emote" && named !== "any") {
    activeFilterChips.push({
      key: "named",
      label: NAMED_FILTERS.find((f) => f.key === named)?.label ?? named,
      clear: () => setNamed("any"),
    });
  }
  if (view === "emote" && pack !== "") {
    activeFilterChips.push({ key: "pack", label: `文件夹：${pack}`, clear: () => setPack("") });
  }
  if (view === "emote" && missingOnly) {
    activeFilterChips.push({ key: "missing", label: "仅失效", clear: () => setMissingOnly(false) });
  }
  if (kind !== "all") {
    activeFilterChips.push({ key: "kind", label: KIND_LABELS[kind as Asset["kind"]] ?? kind, clear: () => setKind("all") });
  }
  const unnamedCount = Math.max(0, naming.total - naming.named);
  const namingProgress = job !== null && job.total > 0
    ? Math.min(100, Math.round((job.done / job.total) * 100))
    : 0;
  // 旧后端可能不带 results 字段：读不到就当空，别让一个可选字段把整页渲染崩掉。
  const jobResults = job?.results ?? [];
  const failedResults = jobResults.filter((r) => r.error !== "");
  const successResults = jobResults.filter((r) => r.error === "");
  const showNamingStatus = view === "emote" || job?.running === true;
  const EmptyIcon = kind === "audio" ? AudioLines : kind === "video" ? Film : view === "chat" ? MessageCircle : ImageIcon;

  return (
    <div className={"card card-pad media-library" + (view === "emote" ? " media-library-emote" : "")} {...panel}>
      {title !== undefined && (
        <>
          <div className="pf-set-title"><span>{title}</span></div>
          <div className="pf-set-sub">
            {contactId === ""
              ? "所有联系人的图片、视频、语音与文件都汇总在这一页。「表情包」是其中一个视角——想让某张图成为随手能发的表情，点卡片上的笑脸。"
              : "只列与这位联系人相关的图片、视频、语音与文件；聊天时可发出的表情在「表情包」视角里统一管。"}
          </div>
        </>
      )}

      <div className="ml-view-row">
        <div className="ml-views" role="tablist" aria-label="媒体视角">
          {VIEWS.map((v) => (
            <button key={v.key} type="button" role="tab" className={"ml-view-tab" + (view === v.key ? " on" : "")}
              title={v.hint} aria-selected={view === v.key} onClick={() => chooseView(v.key)}>
              <span>{v.label}</span>
              <span className="ml-view-count">{counts[v.key] ?? 0}</span>
            </button>
          ))}
        </div>
        {view === "emote" && contactId === "" && (
          <div className="ml-add-actions">
            <button type="button" className="btn sm" disabled={adding !== ""} onClick={() => fileRef.current?.click()}>
              <Upload size={13} /> {adding === "upload" ? "上传中…" : "上传图片"}
            </button>
            <button type="button" className="btn sm" disabled={adding !== ""} onClick={() => { void onImportDir(); }}>
              <FolderInput size={13} /> {adding === "import" ? "导入中…" : "导入文件夹"}
            </button>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden
              onChange={(e) => onPickFile(e.target.files?.[0])} />
          </div>
        )}
      </div>

      <div className="ml-tools">
        <span className="emote-search media-search ml-search">
          <Search size={14} style={{ flexShrink: 0, opacity: 0.5 }} />
          <input value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索名字、标签或文件夹" title={`按名字或标签搜索${activeView.label}`}
            aria-label={`搜索${activeView.label}`} />
          {query !== "" && (
            <button type="button" className="emote-search-clear" aria-label="清除搜索" onClick={() => setQuery("")}>×</button>
          )}
        </span>

        {view === "emote" ? (
          <>
            <FilterMenu label="命名" value={named} options={namedOptions}
              onChange={(next) => { setMissingOnly(false); setNamed(next); }} />

            <div className="ml-pack-picker" ref={packRef}>
              <button type="button" className={"ml-select ml-pack-btn" + (pack !== "" ? " on" : "")}
                aria-expanded={packOpen} aria-haspopup="listbox"
                title="按文件夹筛选；每个文件夹都能直接在文件管理器里打开"
                onClick={togglePack}>
                <FolderOpen size={13} aria-hidden="true" />
                <span className="ml-pack-name">{pack === "" ? "全部文件夹" : pack}</span>
                <span className="content-count">{pack === "" ? naming.total : (packs.find((p) => p.pack === pack)?.total ?? 0)}</span>
                <ChevronDown size={12} className={"ml-pack-caret" + (packOpen ? " on" : "")} aria-hidden="true" />
              </button>
              {packOpen && (
                <div className={"ml-pack-pop" + (packUp ? " up" : "")}>
                  <input value={packQuery} onChange={(e) => setPackQuery(e.target.value)}
                    placeholder="搜文件夹名" aria-label="搜文件夹名" />
                  <button type="button" className={"ml-pack-opt" + (pack === "" ? " on" : "")}
                    onClick={() => { setPack(""); setMissingOnly(false); setPackOpen(false); }}>
                    <span className="ml-pack-name">全部文件夹</span>
                    <span className="content-count">{naming.total}</span>
                  </button>
                  <div className="ml-pack-list" role="listbox" aria-label="文件夹列表">
                    {packs.filter((p) => packQuery.trim() === "" || p.pack.includes(packQuery.trim())).map((p) => (
                      <div key={p.pack} className="ml-pack-row">
                        <button type="button" className={"ml-pack-opt" + (pack === p.pack ? " on" : "")}
                          title={p.unnamed > 0 ? `${p.pack}：${p.total} 张，其中 ${p.unnamed} 张未命名` : `${p.pack}：${p.total} 张`}
                          onClick={() => { setPack(pack === p.pack ? "" : p.pack); setMissingOnly(false); setPackOpen(false); }}>
                          <span className="ml-pack-name">{p.pack}</span>
                          <span className="content-count">{p.total}</span>
                        </button>
                        {DESKTOP && (
                          <button type="button" className="art-act ml-pack-open"
                            aria-label={`在文件管理器中打开 ${p.pack}`}
                            title={`在文件管理器中打开「${p.pack}」文件夹`}
                            onClick={() => openFolderNamed(`${EMOTE_ROOT}/${p.pack}`)}>
                            <FolderOpen size={13} strokeWidth={1.9} />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {broken > 0 && (
              <button type="button" className={"chip ml-broken-chip" + (missingOnly ? " on" : "")}
                aria-pressed={missingOnly}
                title="只显示原图已不在磁盘上的表情；把文件放回原文件夹会自动恢复"
                onClick={() => {
                  const next = !missingOnly;
                  setMissingOnly(next);
                  if (next) { setNamed("any"); setPack(""); setQuery(""); }
                }}>
                失效<span className="content-count">{broken}</span>
              </button>
            )}

            {selectionMode && (
              <button type="button" className="chip ml-select-all-btn"
                title="勾选当前筛选下的全部素材，不受已加载页数限制"
                disabled={rows.length === 0 || selectingAll || list.refreshing}
                onClick={() => { if (allFilteredSelected) setSelected(new Set()); else void selectAllFiltered(); }}>
                {selectingAll ? "选择中…" : list.refreshing ? "更新中…" : allFilteredSelected ? "取消全选" : `全选 ${totalInScope}`}
              </button>
            )}

            <button type="button" className={"chip ml-select-mode" + (selectionMode ? " on" : "")}
              aria-pressed={selectionMode}
              onClick={() => {
                if (selectionMode) { setSelected(new Set()); setSelectionMode(false); }
                else setSelectionMode(true);
              }}>
              {selectionMode ? "完成" : "选择"}
            </button>
          </>
        ) : (
          <FilterMenu label="类型" value={kind} options={kindOptions} onChange={chooseKind} />
        )}
      </div>

      {activeFilterChips.length > 0 && (
        <div className="ml-active-filters" aria-label="已启用筛选">
          <span className="ml-active-label">筛选</span>
          {activeFilterChips.map((f) => (
            <button key={f.key} type="button" className="ml-filter-chip" onClick={f.clear}>
              {f.label}<X size={11} aria-hidden="true" />
            </button>
          ))}
          <button type="button" className="ml-clear-filters"
            onClick={() => { setNamed("any"); setPack(""); setMissingOnly(false); setKind("all"); }}>
            清除
          </button>
        </div>
      )}

      {list.error !== "" && <div className="pf-error">{list.error}</div>}

      {showNamingStatus && (
        <>
          <div className="ml-status" role="status">
            <div className="ml-status-main">
              <Sparkles size={13} aria-hidden="true" />
              {naming.total === 0 ? (
                <span>还没有可识别的表情。上传或导入后，可以在这里让模型补名称。</span>
              ) : (
                <>
                  <span><b>{naming.total}</b> 张表情</span>
                  <span className="ml-status-sep">·</span>
                  <span>{naming.named} 已命名</span>
                  {unnamedCount > 0 && <span className="ml-status-warn">{unnamedCount} 张未命名</span>}
                  {broken > 0 && (
                    <button type="button" className="ml-status-warn ml-linkish"
                      title="只显示原图已不在磁盘上的表情"
                      onClick={() => { setMissingOnly(true); setNamed("any"); setPack(""); setQuery(""); }}>
                      失效 {broken}
                    </button>
                  )}
                </>
              )}
              {job !== null && job.running && (
                <span className="ml-status-running">
                  智能识别中 {job.done}/{job.total}
                  {job.failed > 0 ? ` · 失败 ${job.failed}` : ""}
                  {job.throttleMs > 0 ? " · 已自动降速" : ""}
                  {job.current !== "" && <> · <span className="ml-status-current" title={job.current}>{job.current}</span></>}
                </span>
              )}
              {job !== null && !job.running && job.named + job.failed > 0 && (
                <span className={job.failed > 0 ? "ml-status-warn" : "ml-status-done"}>
                  上次智能识别 {job.named}/{job.total}
                  {job.failed > 0 ? ` · 失败 ${job.failed}` : " · 完成"}
                </span>
              )}
            </div>
            <div className="ml-status-actions">
              {job !== null && !job.running && job.failed > 0 && (
                <button type="button" className="ml-status-warn ml-linkish" onClick={() => { void retryFailed(); }}>
                  失败 {job.failed} 张 · 重试
                </button>
              )}
              {/* 「自动收录」是功能开关，统一滑块；toggleCapture 的入参形状不变（boolean）。 */}
              {contactId === "" && (
                <ToggleSwitch className="ml-capture-compact" title="聊天中收到的图片是否自动存入表情库"
                  label="自动收录" labelSide="right"
                  checked={autoCapture} disabled={adding !== ""}
                  onChange={(next) => { toggleCapture(next); }} />
              )}
              {(naming.total > 0 || job !== null) && (
                <button type="button" className={"ml-naming-detail" + (job?.running === true ? " live" : "")}
                  aria-expanded={showResults} onClick={() => setShowResults(true)}>
                  {job?.running === true ? "查看进度" : "识别详情"}
                </button>
              )}
              {unnamedCount > 0 && job?.running !== true && (
                <button type="button" className="primary sm"
                  title="逐张调用图片理解模型，生成名称、适用场景与标签并写入库"
                  onClick={() => { void runNaming(); }}>
                  <Sparkles size={13} /> 智能识别
                </button>
              )}
            </div>
          </div>
          {job !== null && job.running && (
            <div className="ml-progress" aria-hidden="true"><span style={{ width: `${namingProgress}%` }} /></div>
          )}
        </>
      )}

      {list.page !== null && rows.length === 0 && (
        /* 空 lib 从 .art-empty 换成统一 EmptyState：图标沿用按类型挑好的 EmptyIcon
           （尺寸交给 .empty-state-icon 的样式口径，不再各写各的 26px）。
           文案一刀切成「主文案 + 补充」两段：第一句说为什么空，剩下的是下一步指引。 */
        activeFilters.length > 0 ? (
          <EmptyState icon={<EmptyIcon />} title={`这个筛选下没有素材：${activeFilters.join(" × ")}。`}
            hint="条件叠加后为空不代表库是空的——换个条件，或者清掉筛选。">
            <button type="button" className="btn sm"
              onClick={() => { setQuery(""); setPack(""); setNamed("any"); setMissingOnly(false); setKind("all"); }}>
              清除筛选
            </button>
          </EmptyState>
        ) : (() => {
          const copy = emptyCopyFor(view, kind, who);
          const firstDot = copy.indexOf("。");
          const title = firstDot === -1 ? copy : copy.slice(0, firstDot + 1);
          const hint = firstDot === -1 ? "" : copy.slice(firstDot + 1);
          return <EmptyState icon={<EmptyIcon />} title={title} hint={hint !== "" ? hint : undefined} />;
        })()
      )}

      <div className={"content-grid" + (view === "emote" ? " content-grid-emote" : "")}>
        {rows.map((a) => {
          const isImage = a.kind === "image";
          const title2 = titleOf(a);
          const duration = durationLabel(a.durationMs);
          // 「未命名」是这张卡的状态，不是标题的兜底文案：库里存的是文件句柄时，
          // 把 heart-hands 当名字摊给用户看只会让人问「这是什么」。
          const unnamed = a.usableAsEmote && a.emoteLabel === "";
          return (
            <figure key={a.id} className={"content-cell kind-" + a.kind + (selected.has(a.id) ? " selected" : "")}>
              <div className={"content-shot kind-" + a.kind + (selectionMode ? " selecting" : "")}>
                {view === "emote" && selectionMode && (
                  <label className="content-pick" title={"选中 " + (unnamed ? "未命名" : title2) + " 用于批量操作"}>
                    <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggleSelected(a.id)}
                      aria-label={"选择 " + (unnamed ? "未命名" : title2)} />
                  </label>
                )}
                {isImage && (a.missing ? (
                  <div className="content-missing" role="img" aria-label={title2 + "已失效"}>
                    <ImageOff size={24} strokeWidth={1.6} />
                    <span>原图不在盘上</span>
                  </div>
                ) : (
                  <button type="button" className="content-open"
                    onClick={() => { if (selectionMode) toggleSelected(a.id); else setZoom(a.url); }}
                    aria-label={selectionMode ? `选择 ${title2}` : `放大查看${title2}`}>
                    <img src={a.url} alt={title2} loading="lazy" />
                  </button>
                ))}
                {a.kind === "video" && (
                  <video className="content-video" src={a.url} controls playsInline preload="metadata" aria-label={title2} />
                )}
                {a.kind === "audio" && (
                  <div className="content-audio">
                    <span className="content-audio-icon"><AudioLines size={22} strokeWidth={1.7} /></span>
                    <VoiceMessageBubble compact url={a.url} durationMs={a.durationMs}
                      waveform={a.detail.waveform} transcript={a.detail.transcript || undefined} />
                  </div>
                )}
                {a.kind === "file" && (
                  <div className="content-file"><File size={30} strokeWidth={1.5} /><b>{a.url.split("/").pop()}</b></div>
                )}
                {view !== "emote" && <span className="content-source">{SOURCE_LABELS[a.source] ?? a.source}</span>}
                {a.detail.withReference && <span className="content-badge ref"><Shapes size={11} />带参考</span>}
                {a.usableAsEmote && view !== "emote" && <span className="content-badge face">表情包</span>}
                {a.missing && <span className="content-badge broken">已失效</span>}
                {unnamed && view === "emote" && <span className="content-badge unnamed">未命名</span>}
                {a.usableAsEmote && a.emoteUseCount > 0 && (
                  <span className="content-badge use" title={`这张已发出 ${a.emoteUseCount} 次`}>
                    已发 {a.emoteUseCount} 次
                  </span>
                )}
                {faceRef !== "" && faceRef === a.url && <span className="content-badge face">自拍参考</span>}
                <span className="content-acts" onClick={(e) => e.stopPropagation()}>
                  {isImage && (
                    <button type="button" className="art-act" aria-pressed={a.usableAsEmote} disabled={busyId === a.id}
                      aria-label={a.usableAsEmote ? "移出表情包" : "加入表情包"}
                      title={a.usableAsEmote ? "聊天时不再使用这张" : "让聊天时能用上这张"}
                      onClick={() => { void act(a, a.usableAsEmote ? "unmarkEmote" : "markEmote"); }}>
                      <Smile size={14} strokeWidth={a.usableAsEmote ? 2.8 : 1.8} />
                    </button>
                  )}
                  {a.usableAsEmote && (
                    <button type="button" className="art-act" aria-label="编辑名称与用法" title="编辑这张表情的名称、适用场景与标签"
                      onClick={() => setEdit(a)}>
                      <Pencil size={13} strokeWidth={1.9} />
                    </button>
                  )}
                  {DESKTOP && !a.missing && (
                    <button type="button" className="art-act" aria-label="在文件管理器中显示" title="在文件管理器里定位这个文件"
                      onClick={() => revealAsset(a)}>
                      <FolderOpen size={13} strokeWidth={1.9} />
                    </button>
                  )}
                  {a.missing && (
                    <button type="button" className="art-act danger" aria-label="清理此项" disabled={busyId === a.id}
                      title="原图已不在磁盘上，从库里移除这条记录；文件放回后会自动重新登记"
                      onClick={() => { void act(a, "dropMissing"); }}>
                      <Trash2 size={14} strokeWidth={1.9} />
                    </button>
                  )}
                  <button type="button" className="art-act" aria-pressed={a.starred} disabled={busyId === a.id}
                    aria-label={a.starred ? "取消收藏" : "收藏"} title={a.starred ? "取消收藏" : "收藏"}
                    onClick={() => { void act(a, a.starred ? "unstar" : "star"); }}>
                    <Star size={14} strokeWidth={1.9} fill={a.starred ? "currentColor" : "none"} />
                  </button>
                  {isImage && contactId !== "" && faceRef !== a.url && (
                    <button type="button" className="art-act" aria-label="设为自拍参考" title="设为自拍参考"
                      disabled={busyId === a.id} onClick={() => { void setFaceReference(a); }}>
                      <User size={14} strokeWidth={1.9} />
                    </button>
                  )}
                  {a.detail.artifactId !== "" && (
                    <button type="button" className="art-act danger" aria-label="删除作品" title="删除作品（不可恢复）"
                      disabled={busyId === a.id} onClick={() => setConfirmDel(a)}>
                      <Trash2 size={14} strokeWidth={1.9} />
                    </button>
                  )}
                </span>
              </div>
              <figcaption>
                <span className={"content-title" + (unnamed ? " muted" : "")} title={title2}>
                  {unnamed ? "未命名" : title2}
                  {!unnamed && view === "emote" && a.emoteNameSource === "manual" && (
                    <span className="content-name-src" title="这个名字是你写的或改过的">手动</span>
                  )}
                </span>
                {view === "emote" && a.emoteCaption !== "" && (
                  <span className="content-sub" title={a.emoteCaption}>{a.emoteCaption}</span>
                )}
                <span className="content-meta">
                  {view === "emote" && a.emotePack[0] !== undefined ? a.emotePack[0] + " · " : ""}
                  {whenOf(a.createdAt)}{duration !== "" ? " · " + duration : ""}{a.detail.shape !== "" ? " · " + a.detail.shape : ""}
                </span>
              </figcaption>
            </figure>
          );
        })}
      </div>

      <ListPager page={list.page} busy={list.busy} refreshing={list.refreshing} onMore={list.more} />

      {view === "emote" && showResults && (
        <Modal onClose={() => setShowResults(false)} label="智能识别详情" className="ml-results-modal">
          <div className="ml-results-head">
            <span>{job === null
              ? "还没有运行过智能识别"
              : job.running
                ? `识别进行中 · ${job.done}/${job.total}`
                : `上次智能识别 · 共 ${job.total} 张`}</span>
            {job !== null && job.failed > 0 && !job.running && (
              <button type="button" className="btn sm" onClick={() => { void retryFailed(); }}>
                只重试失败的 {job.failed} 张
              </button>
            )}
          </div>

          {job !== null && job.total > 0 && (
            <div className="ml-results-summary">
              <span><b>{job.total}</b><small>总数</small></span>
              <span className="ok"><b>{job.named}</b><small>成功</small></span>
              <span className={job.failed > 0 ? "bad" : ""}><b>{job.failed}</b><small>失败</small></span>
            </div>
          )}

          {job !== null && job.running && (
            <div className="ml-results-current">
              {job.current !== "" ? `正在识别 ${job.current}` : "正在准备第一张…"}
              {job.failed > 0 ? ` · 已失败 ${job.failed} 张` : ""}
              {job.throttleMs > 0 ? ` · 已自动降速 ${job.throttleMs}ms` : ""}
            </div>
          )}

          {job === null || jobResults.length === 0 ? (
            <div className="ml-results-empty">
              {job !== null && job.running
                ? "识别刚开始，逐张结果会实时出现在这里。"
                : job !== null && job.total > 0
                  ? "上次任务已经结束，但没有留下逐张结果。可以重新运行一次。"
                  : "还没有逐张识别记录。选中素材后点「智能识别」或「智能识别选中」，或直接点「智能识别」。"}
            </div>
          ) : (
            <div className="ml-result-groups">
              {failedResults.length > 0 && (
                <section className="ml-result-group">
                  <div className="ml-result-group-head bad">
                    <span>需要处理</span><span>{failedResults.length} 张</span>
                  </div>
                  <ul className="ml-results-list">
                    {failedResults.slice(0, 60).map((r) => (
                      <li key={r.id + r.file} className="bad">
                        <code>{r.file}</code>
                        <span className="ml-result-reason">{r.error}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {successResults.length > 0 && (
                <section className="ml-result-group">
                  <div className="ml-result-group-head">
                    <span>已完成</span><span>{successResults.length} 张</span>
                  </div>
                  <ul className="ml-results-list">
                    {successResults.slice(0, 60).map((r) => (
                      <li key={r.id + r.file}>
                        <code>{r.file}</code>
                        <span className="ml-result-name">{r.name}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}
        </Modal>
      )}
      {view === "emote" && selected.size > 0 && createPortal(
        <div className="ml-bulk-fixed" role="region" aria-label="批量操作" aria-busy={bulkBusy !== "" || job?.running === true}>
          <span className="ml-bulk-count">
            {bulkBusy !== ""
              ? <>处理中 {bulkDone}/{selected.size}</>
              : <>已选 <b>{selected.size}</b> 张</>}
          </span>
          <button type="button" className="primary sm"
            disabled={bulkBusy !== "" || job?.running === true}
            title="对选中素材逐张调用图片理解模型；已有名称也会被覆盖"
            onClick={() => { void runSelectedNaming(); }}>
            <Sparkles size={13} /> {job?.running === true ? "智能识别中" : "智能识别"}
          </button>
          <button type="button" className="btn sm"
            disabled={bulkBusy !== "" || job?.running === true}
            title="把选中的表情加入收藏"
            onClick={() => { void runBulkAssetAction("star"); }}>
            <Star size={13} /> 收藏
          </button>
          <button type="button" className="btn sm"
            disabled={bulkBusy !== "" || job?.running === true}
            title="把选中的表情移动到另一个文件夹"
            onClick={openBulkMove}>
            <FolderInput size={13} /> 移动
          </button>
          <button type="button" className="btn sm ml-bulk-exit"
            disabled={bulkBusy !== ""} title="退出选择" aria-label="退出选择"
            onClick={() => { setSelected(new Set()); setSelectionMode(false); }}>
            <X size={13} aria-hidden="true" />
            <span className="ml-bulk-exit-label">退出选择</span>
          </button>
        </div>,
        document.body,
      )}

      {bulkMoveOpen && (
        <Modal onClose={() => setBulkMoveOpen(false)} label="移动到文件夹" className="ml-move-modal">
          <p className="ml-lead">把选中的 {selected.size} 张表情移动到：</p>
          <input className="ml-move-search" value={bulkMoveQuery} onChange={(e) => setBulkMoveQuery(e.target.value)}
            placeholder="搜索文件夹" aria-label="搜索目标文件夹" />
          <div className="ml-move-list" role="listbox" aria-label="目标文件夹">
            {moveFolders.filter((folder) => bulkMoveQuery.trim() === "" || folder.includes(bulkMoveQuery.trim())).map((folder) => (
              <button key={folder} type="button" role="option" aria-selected={bulkMoveTarget === folder}
                className={"ml-move-opt" + (bulkMoveTarget === folder ? " on" : "")}
                onClick={() => setBulkMoveTarget(folder)}>
                <FolderOpen size={14} aria-hidden="true" />
                <span>{folder}</span>
                {bulkMoveTarget === folder && <span className="ml-move-check">已选</span>}
              </button>
            ))}
            {moveFolders.every((folder) => bulkMoveQuery.trim() !== "" && !folder.includes(bulkMoveQuery.trim())) && (
              <div className="ml-move-empty">没有匹配的文件夹</div>
            )}
          </div>
          <div className="row2">
            <button type="button" className="btn sm" onClick={() => setBulkMoveOpen(false)}>取消</button>
            <button type="button" className="primary sm" disabled={bulkMoveTarget === "" || selected.size === 0}
              onClick={() => {
                const target = bulkMoveTarget;
                setBulkMoveOpen(false);
                void runBulkAssetAction("moveEmote", { pack: [target] });
              }}>
              移动 {selected.size} 张
            </button>
          </div>
        </Modal>
      )}

      {/* 大图要看的是"我点的那张"，所以必须挂在 body 上：壁纸（玻璃）模式下这张卡带
          backdrop-filter，会成为 position:fixed 后代的包含块——留在这里的话遮罩只盖住卡片，
          图被居中到整张三千像素高的卡片中间，人得往下滑才找得到它。 */}
      {zoom !== null && createPortal(
        <div className="img-zoom" onClick={() => setZoom(null)} role="dialog" aria-modal="true"
          aria-label="大图" data-keep-menu>
          <img src={zoom} alt="大图" onClick={(e) => e.stopPropagation()} />
          <button type="button" aria-label="关闭" onClick={() => setZoom(null)}><X size={18} /></button>
        </div>,
        document.body,
      )}

      {confirmDel !== null && (
        <Modal onClose={() => setConfirmDel(null)} label="删除作品">
          <p className="ml-lead">
            这个作品和磁盘文件会一起删除，<b>不可恢复</b>。聊天记录里的引用也会随之失效。
          </p>
          {confirmDel.kind === "image"
            ? <img className="art-confirm-shot" src={confirmDel.url} alt="将要删除的作品" />
            : confirmDel.kind === "video"
              ? <video className="art-confirm-shot" src={confirmDel.url} controls playsInline preload="metadata" />
              : confirmDel.kind === "audio"
                ? <div className="art-confirm-audio"><VoiceMessageBubble url={confirmDel.url} durationMs={confirmDel.durationMs}
                    waveform={confirmDel.detail.waveform} transcript={confirmDel.detail.transcript || undefined} /></div>
                : <div className="art-confirm-file"><File size={28} /><span>{confirmDel.url.split("/").pop()}</span></div>}
          <div className="row2">
            <button type="button" className="btn sm" onClick={() => setConfirmDel(null)}>取消</button>
            <button type="button" className="primary danger sm" disabled={busyId === confirmDel.id}
              onClick={() => { const a = confirmDel; setConfirmDel(null); void deleteArtifact(a); }}>
              删除作品
            </button>
          </div>
        </Modal>
      )}
      {edit !== null && (
        <EmoteSemanticsModal asset={edit} folders={packs.map((p) => p.pack)}
          onSave={saveSemantics} onRename={renameOne} onClose={() => setEdit(null)} queueLine={renameHint} />
      )}

      {/* 动作反馈与聊天同一套轻提示浮层；portal 到 body，免得按带 transform 的祖先定位。
          失败是红色那一档（.toast.warn），和成功共用同一个位置、同一套动效。 */}
      {toast !== null && createPortal(
        <div className="toast-layer" role="status" aria-live="polite">
          <div className={"toast" + (toast.tone === "warn" ? " warn" : "")}>{toast.text}</div>
        </div>,
        document.body,
      )}
    </div>
  );
}
