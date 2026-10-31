// 设置页「表情」分区：QQ 表情系统的素材库管理（搜索/标签筛选/网格/上传/目录/采集/内置词表）。
//
// 设计原则：
//   - 网格为主视图，搜索 + 标签 chips 为两层过滤（AND 关系：搜「大笑」且标签含「鲸鱼娘」= 鲸鱼娘里的"大笑"）。
//   - 空 label 兜底显第一个 tag（哈希文件入库时不露出 0f2ea3fa… 这种丑名）。
//   - 内置词表摊成 chips（hover 显示 emoji + face id），让用户知道哪些 keyword 能命中 face。
//   - 渠道能力横幅常驻（官方渠道发不了 face/mface，要 OneBot 才原生）。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderInput, Info, Search, Trash2, Upload } from "lucide-react";
import * as emotesApi from "../../api/emotes";
import type { EmoteAsset, EmoteFace, EmoteOverview } from "../../api/emotes";

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export default function EmoteSection({ ask }: {
  ask: (title: string, note: string, run: () => void) => void;
}): JSX.Element {
  const [data, setData] = useState<EmoteOverview | null>(null);
  const [faces, setFaces] = useState<EmoteFace[]>([]);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const [dir, setDir] = useState("");
  const [tag, setTag] = useState("");
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState<string>("");
  const fileRef = useRef<HTMLInputElement>(null);

  const caps = data?.capabilities;
  const degraded = caps !== undefined && caps.backend === "official";
  const assets = data?.assets ?? [];

  // 聚合所有 tag（去重 + 计数），驱动筛选 chips。
  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of assets) for (const t of a.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  }, [assets]);

  // 两层过滤：搜索（label/tags 包含）AND 标签（仅 activeTag）。
  const filtered = useMemo(() => {
    let out = assets;
    if (activeTag !== "") out = out.filter((a) => a.tags.includes(activeTag));
    const q = query.trim().toLowerCase();
    if (q !== "") out = out.filter((a) => {
      if (a.label.toLowerCase().includes(q)) return true;
      return a.tags.some((t) => t.toLowerCase().includes(q));
    });
    return out;
  }, [assets, activeTag, query]);

  const load = useCallback((): void => {
    setBusy("load");
    emotesApi.overview()
      .then((d) => {
        setData(d);
        // 拉内置词表。
        emotesApi.faces().then((r) => setFaces(r.faces)).catch(() => {});
      })
      .catch((e: unknown) => setErr(errText(e)))
      .finally(() => setBusy(""));
  }, []);

  useEffect(() => { load(); }, [load]);

  const flash = (text: string, good: boolean): void => {
    setNote(text); setErr(good ? "" : text); if (!good) setNote("");
    window.setTimeout(() => { setNote(""); if (!good) setErr(""); }, 4000);
  };

  const onPickFile = (file: File | undefined): void => {
    if (file === undefined) return;
    setBusy("upload");
    emotesApi.upload(file)
      .then(() => { load(); flash("已上传。", true); })
      .catch((e: unknown) => flash(errText(e), false))
      .finally(() => { setBusy(""); if (fileRef.current) fileRef.current.value = ""; });
  };

  const onImportDir = (): void => {
    if (dir.trim() === "") { flash("先填一个本地文件夹路径", false); return; }
    setBusy("import");
    emotesApi.importDir(dir.trim(), tag.trim() !== "" ? tag.trim() : undefined)
      .then((r) => { load(); flash(`导入 ${r.added} 张${r.skipped > 0 ? `（跳过 ${r.skipped}）` : ""}。`, true); setDir(""); setTag(""); })
      .catch((e: unknown) => flash(errText(e), false))
      .finally(() => setBusy(""));
  };

  const toggleCapture = (on: boolean): void => {
    setBusy("pref");
    emotesApi.setAutoCapture(on)
      .then((r) => { setData((d) => (d ? { ...d, autoCapture: r.autoCapture } : d)); flash(on ? "自动采集已开。" : "已关闭。", true); })
      .catch((e: unknown) => flash(errText(e), false))
      .finally(() => setBusy(""));
  };

  const remove = (asset: EmoteAsset): void => {
    const name = asset.label !== "" ? asset.label : (asset.tags[0] ?? asset.url);
    ask(`删掉表情包「${name}」？`, "只从素材库摘掉，文件本体交给媒体回收通道。", () => {
      setBusy("del");
      emotesApi.remove(asset.url)
        .then(() => { load(); flash(`已删「${name}」。`, true); })
        .catch((e: unknown) => flash(errText(e), false))
        .finally(() => setBusy(""));
    });
  };

  /** 网格卡片显示名：素材库里已不会再出现哈希名（后端写入侧挡掉 + 存量清洗），
   *  真没名字的（自动采集来的）就标「未命名」，让下面那行标签去说明它属于哪一批。 */
  const displayName = (a: EmoteAsset): string => a.label !== "" ? a.label : "未命名";

  const chipTags = [...tagCounts.keys()].sort();

  return (
    <div className="section emote-section" id="settings-emotes">
      <h2>表情</h2>
      <div className="desc">
        给她备一批随手能甩的表情包。接梗、反应、表示态度时她会从这里挑，命中就发一张。
      </div>

      {/* 统计 + 采集 */}
      <div className="settings-overview-strip">
        <span>
          <b>{data?.stats.total ?? 0}</b> 张{(data?.stats.cap ?? 0) > 0 ? ` / ${data?.stats.cap ?? 0}` : "（不限）"}
        </span>
        <span>{chipTags.length} 个标签</span>
        <span>{data?.autoCapture ? "自动采集开" : "自动采集关"}</span>
      </div>

      {/* 渠道能力横幅 */}
      {caps !== undefined && (
        <div className={"banner show " + (degraded ? "bad" : "ok")} role="status">
          <div className="body">
            <Info size={13} style={{ verticalAlign: "-2px" }} />{" "}
            {degraded
              ? "当前是**官方渠道**：图片表情包能发，内置表情/商城动态表情会降级成 emoji/文字。想原生发动态表情切到 OneBot 协议端。"
              : "当前是 **OneBot 协议端**：图片、内置表情、商城动态表情都能原生发。"}
          </div>
        </div>
      )}

      {/* 上传 */}
      <div className="card card-pad emote-upload">
        <div className="subhead">加表情包</div>
        <div className="hint">选一张图（png / jpg / webp / gif，≤5MB），落进媒体库并登记成素材。</div>
        <div className="actions">
          <button type="button" className="primary sm" disabled={busy !== ""} onClick={() => fileRef.current?.click()}>
            <Upload size={13} /> {busy === "upload" ? "上传中…" : "上传图片"}
          </button>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden
            onChange={(e) => onPickFile(e.target.files?.[0])} />
        </div>
      </div>

      {/* 目录导入 */}
      <div className="card card-pad emote-import">
        <div className="subhead">整批导入本地文件夹</div>
        <div className="hint">把一批梗图放进一个文件夹，按内容去重一次性入库——重复扫不会越扫越脏。</div>
        <div className="form-row" style={{ marginTop: 8 }}>
          <div className="field" style={{ flex: 2, minWidth: 0 }}>
            <input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="本地文件夹路径" />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 0 }}>
            <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="统一标签（可选）" />
          </div>
        </div>
        <div className="actions" style={{ marginTop: 8 }}>
          <button type="button" className="btn sm" disabled={busy !== ""} onClick={onImportDir}>
            <FolderInput size={13} /> {busy === "import" ? "导入中…" : "导入"}
          </button>
        </div>
      </div>

      {/* 自动采集 */}
      <div className="card card-pad emote-capture">
        <div className="subhead">自动采集</div>
        <div className="hint">开启后他发来的图片会顺手登记成素材——越聊越多，接梗越快。默认关。</div>
        <div className="preset-row cap-pro-row">
          <label className="cap-enable">
            <input type="checkbox" checked={data?.autoCapture === true} disabled={busy !== ""}
              onChange={(e) => toggleCapture(e.target.checked)} />
            把他发来的图收进表情包
          </label>
        </div>
      </div>

      {/* 搜索 + 标签筛选 */}
      {assets.length > 0 && (
        <div className="emote-toolbar">
          <div className="emote-search">
            <Search size={14} style={{ flexShrink: 0, opacity: 0.5 }} />
            <input value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder={`搜 ${assets.length} 张表情（按名字或标签）`} />
            {query !== "" && (
              <button type="button" className="emote-search-clear" aria-label="清除"
                onClick={() => setQuery("")}>×</button>
            )}
          </div>
          <div className="emote-tag-chips">
            <button type="button" className={"chip" + (activeTag === "" ? " on" : "")} onClick={() => setActiveTag("")}>
              全部
            </button>
            {chipTags.map((t) => (
              <button key={t} type="button" className={"chip" + (activeTag === t ? " on" : "")}
                onClick={() => setActiveTag(t)}>{t} <small>{tagCounts.get(t)}</small></button>
            ))}
          </div>
        </div>
      )}

      {/* 网格 */}
      {assets.length === 0 ? (
        <div className="empty">素材库还是空的。传一张图、导一个文件夹，或开自动采集，她才会甩得出来。</div>
      ) : filtered.length === 0 ? (
        <div className="empty">没搜到「{query || activeTag}」。换关键词或清筛选试试。</div>
      ) : (
        <div className="card emote-grid" aria-label="表情包列表">
          {filtered.map((asset) => (
            <div key={asset.url} className="emote-item">
              <img src={asset.url} alt={displayName(asset)} loading="lazy" />
              <div className="emote-item-cap">
                <span className="emote-item-label">{displayName(asset) || "表情包"}</span>
                {asset.tags.length > 0 && (
                  <span className="emote-item-tags">{asset.tags.filter((t) => t !== asset.label).slice(0, 2).join(" ")}</span>
                )}
              </div>
              <button type="button" className="emote-item-del" aria-label={`删掉 ${displayName(asset)}`}
                disabled={busy !== ""} onClick={() => remove(asset)}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 内置表情词表 */}
      {faces.length > 0 && (
        <div className="card card-pad emote-faces">
          <div className="subhead">内置表情词</div>
          <div className="hint">这些词能命中 QQ 内置表情（官方渠道降级成 emoji）。点一个看看她的表情长啥样。</div>
          <div className="emote-face-chips">
            {faces.map((f) => (
              <button key={f.keyword + f.id} type="button" className="emote-face-chip"
                title={`${f.emoji} face #${f.id}`}
                onClick={() => window.open(`data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text x="50" y="58" text-anchor="middle" font-size="48">${f.emoji}</text></svg>`)}`, "_blank", "width=120,height=120")}>
                {f.emoji} <span>{f.keyword}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {err !== "" && <div className="banner show bad" role="alert"><div className="body">{err}</div></div>}
      {note !== "" && <div className="banner show ok" role="status"><div className="body">{note}</div></div>}
    </div>
  );
}
