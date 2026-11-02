import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AudioLines, ChevronDown, File, Film, FolderInput, FolderOpen, Image as ImageIcon, MessageCircle, Pencil, Search, Shapes, Smile, Sparkles, Star, Trash2, Upload, User, X } from "lucide-react";
import { artifactApi, assetsApi, contactsApi, emotesApi, type Asset, type AssetKindFilter, type AssetView, type EmoteNamedFilter, type EmotePackCount, type NamingJob, type NamingStats } from "../api";
import { pickDirectory } from "../lib/native-dialog";
import EmoteSemanticsModal from "./EmoteSemanticsModal";
import ListPager from "./ListPager";
import Modal from "./Modal";
import VoiceMessageBubble from "./VoiceMessageBubble";
import { revealInFolder } from "../lib/reveal-folder";
import { usePagedList } from "../hooks/usePagedList";
import { useDismiss } from "../hooks/useDismiss";
import type { PanelAria } from "./Tabs";

/**
 * 媒体库：她有过、收到过、画过的东西都在这一页。
 *
 * 这一页取代了原来那两处内容浏览实现（设置里「表情」的网格、联系人页的「媒体」面板）。
 * 它们本来就在做同一件事——列一批 /media 文件、能搜能筛能预览能删——只是各写了一遍，
 * 于是同一个「删除」在两处含义不同。现在视角是参数：
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
  { key: "auto", label: "智能命名", hint: "由图片理解模型识别出来的名字" },
  { key: "manual", label: "手动维护", hint: "你自己写或改过的名字（重新识别会覆盖它们）" },
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
  const [naming, setNaming] = useState<NamingStats>({ total: 0, named: 0, auto: 0, manual: 0 });
  const [packs, setPacks] = useState<EmotePackCount[]>([]);
  const [mediaDir, setMediaDir] = useState("");
  const [broken, setBroken] = useState(0);
  const [job, setJob] = useState<NamingJob | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  const [edit, setEdit] = useState<Asset | null>(null);
  const [confirmDel, setConfirmDel] = useState<Asset | null>(null);
  useDismiss(!!zoom, () => setZoom(null));

  const fetchPage = useCallback((limit: number, offset: number) =>
    assetsApi.listAssets({ view, kind, q: query, pack, named, contactId, limit, offset }).then((d) => {
      setCounts(d.counts);
      setKindCounts(d.kindCounts);
      setNaming(d.naming);
      setPacks(d.packs);
      setMediaDir(d.mediaDir);
      setBroken(d.stats.broken ?? 0);
      return { rows: d.items, total: d.total };
    }), [view, kind, query, pack, named, contactId]);
  const list = usePagedList<Asset>(fetchPage, {
    key: contactId + ":" + view + ":" + kind + ":" + pack + ":" + named + ":" + query + ":" + refreshKey,
    enabled: active,
  });

  const wasActiveRef = useRef(active);
  useEffect(() => {
    const wake = active && !wasActiveRef.current;
    wasActiveRef.current = active;
    if (wake) list.reset();
  }, [active, list]);

  const chooseView = (next: AssetView): void => { setView(next); setKind("all"); setPack(""); setNamed("any"); setNotice(""); setErr(""); setPackOpen(false); };
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
  useEffect(() => {
    if (!polling) return;
    const timer = window.setInterval(() => {
      emotesApi.namingStatus()
        .then((d) => {
          setJob(d.job); setNaming(d.naming);
          if (!d.job.running) {
            setPolling(false);
            // 跑完就把「已开始识别…」那条撤掉：概览条已经写着上一轮结果，
            // 留着启动文案会让人以为还在跑（用户截图里就是这条没消失）。
            setNotice("");
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
    try {
      const d = await emotesApi.startNaming(options);
      setJob(d.job);
      setNaming(d.naming);
      if (d.job.running) {
        setPolling(true);
        setNotice(d.started
          ? `已开始识别，共 ${d.job.total} 张（后台运行）。`
          : `识别正在进行，共 ${d.job.total} 张。`);
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
      .then(() => { setNotice("已加入。这张还未命名——点「智能识别」补个名字，她才能在对话里找到它。"); list.reset(); })
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
        setNotice(`已导入 ${r.added} 张到「${baseName(picked.path)}」${r.skipped > 0 ? `，跳过 ${r.skipped} 张重复` : ""}。未命名的点「智能识别」补名。`);
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

  /** 弹窗里的单张识别：不关窗、把写回的字段交还弹窗原地展示（识别完就消失会让人以为没发生）。 */
  const renameOne = async (): Promise<{ label: string; caption: string; tags: string[] } | null> => {
    if (edit === null) return null;
    const r = await emotesApi.renameOne(edit.id);
    if (r.ok !== true) throw new Error(r.error ?? "这一张识别失败");
    list.reset();
    return { label: r.name, caption: r.caption, tags: r.tags };
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
  const activeView = VIEWS.find((v) => v.key === view) ?? VIEWS[0]!;
  // 选中文件夹时，命名状态 chips 的数字跟着文件夹走：全库数字不随筛选变，
  // 会被读成「筛选坏了」（2026-11-02 用户实测：未命名 0 × 鲸鱼娘·静态 89 → 空网格 + 数字不动）。
  const packRow = pack === "" ? undefined : packs.find((p) => p.pack === pack);
  const scopeCounts = packRow === undefined
    ? { unnamed: naming.total - naming.named, auto: naming.auto, manual: naming.manual }
    : { unnamed: packRow.unnamed, auto: packRow.auto, manual: packRow.manual };
  const activeFilters: string[] = [];
  if (query.trim() !== "") activeFilters.push(`“${query.trim()}”`);
  if (view === "emote" && named !== "any") {
    activeFilters.push(NAMED_FILTERS.find((f) => f.key === named)?.label ?? named);
  }
  if (view === "emote" && pack !== "") activeFilters.push(`文件夹「${pack}」`);
  if (kind !== "all") activeFilters.push(KIND_LABELS[kind as Asset["kind"]] ?? kind);
  // 旧后端可能不带 results 字段：读不到就当空，别让一个可选字段把整页渲染崩掉。
  const jobResults = job?.results ?? [];
  const EmptyIcon = kind === "audio" ? AudioLines : kind === "video" ? Film : view === "chat" ? MessageCircle : ImageIcon;

  return (
    <div className="card card-pad media-library" {...panel}>
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

      <div className="content-filters" role="group" aria-label="视角">
        {VIEWS.map((v) => (
          <button key={v.key} type="button" className={"chip" + (view === v.key ? " on" : "")}
            title={v.hint} aria-pressed={view === v.key} onClick={() => chooseView(v.key)}>
            {v.label}<span className="content-count">{counts[v.key] ?? 0}</span>
          </button>
        ))}
      </div>

      {/* 搜索框单独一行：它和类型 chips 挤在同一条横向滚动带里时，窄屏上会被卷掉半个
          （实测 420px 下输入框左边缘在 -1px，主控件看不见也没法点）。 */}
      <div className="content-search-row">
        <span className="emote-search media-search">
          <Search size={14} style={{ flexShrink: 0, opacity: 0.5 }} />
          {/* 占位文案要短：这一行还要放类型 chips，写长了会被截断成半句话。 */}
          <input value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder={`搜${activeView.label}`} title={`按名字或标签搜索${activeView.label}`}
            aria-label={`搜索${activeView.label}`} />
          {query !== "" && (
            <button type="button" className="emote-search-clear" aria-label="清除" onClick={() => setQuery("")}>×</button>
          )}
        </span>
      </div>

      {/* 类型筛选只在非表情视角出现：表情包全是图片，那一排「视频 0 / 语音 0 / 文件 0」
          在这个视角里是纯噪声，还会和命名状态、文件夹挤成三排 chips。 */}
      {view !== "emote" && (
        <div className="content-filters content-kind-filters" role="group" aria-label="类型">
          {KINDS.map((f) => {
            const count = kindCounts[f.key] ?? 0;
            return (
              <button key={f.key} type="button" className={"chip" + (kind === f.key ? " on" : "")}
                title={f.hint} disabled={f.key !== "all" && count === 0} aria-pressed={kind === f.key}
                onClick={() => chooseKind(f.key)}>
                {f.key === "image" && <ImageIcon size={13} />}
                {f.key === "video" && <Film size={13} />}
                {f.key === "audio" && <AudioLines size={13} />}
                {f.key === "file" && <File size={13} />}
                {f.label}<span className="content-count">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {list.error !== "" && <div className="pf-error">{list.error}</div>}

      {/* 表情视角特有的两块：识别进度 + 文件夹筛选。别的视角不放，因为它们管的就是表情包。 */}
      {view === "emote" && (
        <div className="ml-naming">
          <div className="ml-naming-copy">
            <Sparkles size={14} aria-hidden="true" />
            {naming.total === 0 ? (
              <span>还没有可识别的表情。在任意视角点卡片上的笑脸，把要用的图加进来。</span>
            ) : (
              <span>
                共 <b>{naming.total}</b> 张：智能命名 <b>{naming.auto}</b> · 手动维护 <b>{naming.manual}</b>
                {naming.total - naming.named > 0
                  ? <> · <b className="warn">{naming.total - naming.named} 张未命名</b>（未命名的在对话中检索不到）</>
                  : "（都已命名）"}
                {broken > 0
                  ? <> · <b className="warn">失效 {broken}</b>（原图不在盘上，放回文件夹即恢复）</>
                  : ""}
              </span>
            )}
            {job !== null && job.running && (
              <span className="ml-naming-progress">
                识别中 {job.done}/{job.total}
                {job.failed > 0 ? ` · ${job.failed} 张失败` : ""}
                {job.throttleMs > 0 ? " · 服务商限流，已自动降速" : ""}
                {job.current !== "" ? ` · 当前 ${job.current}` : ""}
              </span>
            )}
            {job !== null && !job.running && job.total > 0 && (
              <button type="button" className="ml-naming-toggle" aria-expanded={showResults}
                onClick={() => setShowResults((v) => !v)}>
                上一轮结果：成功 {job.named} / 共 {job.total}{job.failed > 0 ? ` · 失败 ${job.failed}` : ""}
              </button>
            )}
          </div>
          <div className="ml-naming-acts">
            {contactId === "" && (
              <>
                <button type="button" className="btn sm" disabled={adding !== ""} onClick={() => fileRef.current?.click()}>
                  <Upload size={13} /> {adding === "upload" ? "上传中…" : "上传图片"}
                </button>
                <button type="button" className="btn sm" disabled={adding !== ""} onClick={() => { void onImportDir(); }}>
                  <FolderInput size={13} /> {adding === "import" ? "导入中…" : "导入文件夹"}
                </button>
                <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden
                  onChange={(e) => onPickFile(e.target.files?.[0])} />
              </>
            )}
            {naming.total > 0 && (
              <button type="button" className="btn sm" disabled={job !== null && job.running}
                title="打开识别结果与文件夹管理：看每张识别成了什么、哪几张要重试"
                onClick={() => { setShowResults((v) => !v); }}>
                识别详情
              </button>
            )}
            {naming.named < naming.total && (
              <button type="button" className="primary sm" disabled={job !== null && job.running}
                title="逐张调用图片理解模型，生成名称、适用场景与标签并写入库；只处理未命名的那些，中断后可继续"
                onClick={() => { void runNaming(); }}>
                <Sparkles size={13} /> {job !== null && job.running ? "识别中" : "智能识别"}
              </button>
            )}
          </div>
        </div>
      )}

      {/* 识别详情：本轮逐张结果（失败的排前面，能直接只重试那几张）+ 文件夹管理。
          这两个都是「机器做过的事要能被查、能被改」的那一半——没有它们，
          用户只能看到一排名字，不知道哪些是猜的、哪些没猜动。 */}
      {view === "emote" && showResults && jobResults.length > 0 && (
        <div className="ml-results">
          <div className="ml-results-head">
            <span>上一轮逐张结果（{jobResults.length} 条，失败的排在前面）</span>
            {job !== null && job.failed > 0 && (
              <button type="button" className="btn sm" disabled={job.running}
                onClick={() => { void retryFailed(); }}>只重试失败的 {job.failed} 张</button>
            )}
          </div>
          <ul className="ml-results-list">
            {jobResults.slice(0, 60).map((r) => (
              <li key={r.id + r.file} className={r.error !== "" ? "bad" : ""}>
                <code>{r.file}</code>
                {r.error !== ""
                  ? <span className="ml-result-reason">{r.error}</span>
                  : <span className="ml-result-name">{r.name}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 表情包视角的筛选收成一行：命名状态（3 个值，用 chips）+ 文件夹（几十个值，用下拉）。
          文件夹曾经是一整面 chips 墙，和类型、状态混在一起分不清哪个是分类哪个是标签——
          维度多的筛选就该收进一个控件里，而不是摊在页面上。 */}
      {view === "emote" && (
        <div className="ml-toolbar">
          <div className="ml-toolbar-chips" role="group" aria-label="命名状态">
            {NAMED_FILTERS.map((f) => (
              <button key={f.key} type="button" className={"chip" + (named === f.key ? " on" : "")}
                aria-pressed={named === f.key} title={f.hint} onClick={() => setNamed(named === f.key ? "any" : f.key)}>
                {f.label}
                <span className="content-count">
                  {f.key === "unnamed" ? scopeCounts.unnamed : f.key === "auto" ? scopeCounts.auto : scopeCounts.manual}
                </span>
              </button>
            ))}
          </div>
          <div className="ml-pack-picker" ref={packRef}>
            <button type="button" className={"chip ml-pack-btn" + (pack !== "" ? " on" : "")}
              aria-expanded={packOpen} aria-haspopup="listbox"
              title="按文件夹筛选；每个文件夹都能直接在文件管理器里打开"
              onClick={togglePack}>
              <FolderOpen size={13} aria-hidden="true" />
              {pack === "" ? "全部文件夹" : pack}
              <span className="content-count">{pack === "" ? naming.total : (packs.find((p) => p.pack === pack)?.total ?? 0)}</span>
              <ChevronDown size={12} className={"ml-pack-caret" + (packOpen ? " on" : "")} aria-hidden="true" />
            </button>
            {packOpen && (
              <div className={"ml-pack-pop" + (packUp ? " up" : "")}>
                <input value={packQuery} onChange={(e) => setPackQuery(e.target.value)}
                  placeholder="搜文件夹名" aria-label="搜文件夹名" />
                <button type="button" className={"ml-pack-opt" + (pack === "" ? " on" : "")}
                  onClick={() => { setPack(""); setPackOpen(false); }}>
                  <span className="ml-pack-name">全部文件夹</span>
                  <span className="content-count">{naming.total}</span>
                </button>
                <div className="ml-pack-list" role="listbox" aria-label="文件夹列表">
                  {packs.filter((p) => packQuery.trim() === "" || p.pack.includes(packQuery.trim())).map((p) => (
                    <div key={p.pack} className="ml-pack-row">
                      <button type="button" className={"ml-pack-opt" + (pack === p.pack ? " on" : "")}
                        title={p.unnamed > 0 ? `${p.pack}：${p.total} 张，其中 ${p.unnamed} 张未命名` : `${p.pack}：${p.total} 张`}
                        onClick={() => { setPack(pack === p.pack ? "" : p.pack); setPackOpen(false); }}>
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
        </div>
      )}
      {view === "emote" && contactId === "" && (
        <label className="cap-enable ml-capture">
          <input type="checkbox" checked={autoCapture} disabled={adding !== ""}
            onChange={(e) => { toggleCapture(e.target.checked); }} />
          自动收录聊天中收到的图片
        </label>
      )}

      {list.page !== null && rows.length === 0 && (
        <div className="art-empty">
          <EmptyIcon size={26} strokeWidth={1.5} />
          {activeFilters.length > 0 ? (
            <>
              <p>
                这个筛选下没有素材：{activeFilters.join(" × ")}。
                条件叠加后为空不代表库是空的——换个条件，或者清掉筛选。
              </p>
              <button type="button" className="btn sm"
                onClick={() => { setQuery(""); setPack(""); setNamed("any"); setKind("all"); }}>
                清除筛选
              </button>
            </>
          ) : (
            <p>{emptyCopyFor(view, kind, who)}</p>
          )}
        </div>
      )}

      <div className="content-grid">
        {rows.map((a) => {
          const isImage = a.kind === "image";
          const title2 = titleOf(a);
          const duration = durationLabel(a.durationMs);
          // 「未命名」是这张卡的状态，不是标题的兜底文案：库里存的是文件句柄时，
          // 把 heart-hands 当名字摊给用户看只会让人问「这是什么」。
          const unnamed = a.usableAsEmote && a.emoteLabel === "";
          return (
            <figure key={a.id} className={"content-cell kind-" + a.kind}>
              <div className={"content-shot kind-" + a.kind}>
                {isImage && (
                  <button type="button" className="content-open" onClick={() => setZoom(a.url)} aria-label={"放大查看" + title2}>
                    <img src={a.url} alt={title2} loading="lazy" />
                  </button>
                )}
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
                <span className="content-source">{SOURCE_LABELS[a.source] ?? a.source}</span>
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
              </div>
              <figcaption>
                <span className={"content-title" + (unnamed ? " muted" : "")} title={title2}>
                  {unnamed ? "未命名" : title2}
                  {!unnamed && view === "emote" && (
                    /* 名字是谁给的要能一眼看出来：机器起的要抽查，人写的别再被覆盖。 */
                    <span className="content-name-src"
                      title={a.emoteNameSource === "manual" ? "这个名字是你写的/改过的" : "由智能识别生成，可修改"}>
                      {a.emoteNameSource === "manual" ? "手动" : "AI"}
                    </span>
                  )}
                </span>
                {view === "emote" && a.emoteCaption !== "" && (
                  <span className="content-sub" title={a.emoteCaption}>{a.emoteCaption}</span>
                )}
                <span className="content-meta">
                  {whenOf(a.createdAt)}{duration !== "" ? " · " + duration : ""}{a.detail.shape !== "" ? " · " + a.detail.shape : ""}
                </span>
                <span className="content-acts">
                  {isImage && (
                    <button type="button" className="art-act" aria-pressed={a.usableAsEmote} disabled={busyId === a.id}
                      aria-label={a.usableAsEmote ? "移出表情包" : "加入表情包"}
                      title={a.usableAsEmote ? "聊天时不再使用这张" : "让聊天时能用上这张"}
                      onClick={() => { void act(a, a.usableAsEmote ? "unmarkEmote" : "markEmote"); }}>
                      {/* 不用 fill=currentColor：笑脸是圆脸，一填就糊成一坨实心圆，认不出是表情。
                          点亮状态靠描边加粗表达。 */}
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
              </figcaption>
            </figure>
          );
        })}
      </div>

      <ListPager page={list.page} busy={list.busy} refreshing={list.refreshing} onMore={list.more} />

      {zoom !== null && (
        <div className="img-zoom" onClick={() => setZoom(null)} role="dialog" aria-modal="true"
          aria-label="大图" data-keep-menu>
          <img src={zoom} alt="大图" onClick={(e) => e.stopPropagation()} />
          <button type="button" aria-label="关闭" onClick={() => setZoom(null)}><X size={18} /></button>
        </div>
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
          onSave={saveSemantics} onRename={renameOne} onClose={() => setEdit(null)} />
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
