import { useEffect, useState } from "react";
import { Sparkles, X } from "lucide-react";
import Modal from "./Modal";
import type { Asset } from "../api";

/**
 * 一张表情的语义卡：名称、适用场景、检索标签、文件夹归属。
 *
 * 为什么值得给一个弹窗：
 * 名称是这套系统的检索入口，改错了就等于把这张图从联系人手里藏起来——需要一个能看清整张图
 * 再决定的地方。所以左边是真图，右边是几个字段，输入全部受控（失焦才提交那种写法在这里会
 * 让人以为已经保存了）。
 *
 * 「智能识别」在弹窗里跑完**不关窗**：结果当场回填进字段、行内说明写了什么名字——
 * 认完直接消失会让人以为没发生。不满意可以就地改完再保存，
 * 也可以再点一次。
 *
 * 文件夹是**下拉单选**（默认排第一）：每张表情恰好属于一个文件夹，改归属就是把它挪进另一叠；
 * 文件原名只读，那是来源事实。
 */

/** 与后端 DEFAULT_EMOTE_FOLDER 同值：没得选时的兜底归属。 */
const DEFAULT_FOLDER = "默认";

/** 单张识别写回的结果：弹窗拿它原地回填，而不是关掉让人去网格里找。 */
export type RenameOutcome = { label: string; caption: string; tags: string[] };

export default function EmoteSemanticsModal({
  asset, folders, onSave, onRename, onClose, queueLine = "",
}: {
  asset: Asset;
  /** 库里现有的文件夹名清单（全库级，不随当前筛选变）。 */
  folders: string[];
  /** 保存：把四个可编辑字段交回上层，由上层调接口。 */
  onSave: (patch: { label: string; caption: string; tags: string[]; pack: string[] }) => Promise<void>;
  /** 让模型再看这一张；返回写回的字段给弹窗原地展示。 */
  onRename: () => Promise<RenameOutcome | null>;
  onClose: () => void;
  /** 队列里的进度文本，来自 MediaLibrary 的 queueLine 状态。 */
  queueLine?: string;
}): JSX.Element {
  const [label, setLabel] = useState(asset.emoteLabel);
  const [caption, setCaption] = useState(asset.emoteCaption);
  const [tags, setTags] = useState<string[]>(asset.emoteTags);
  const [folder, setFolder] = useState(asset.emotePack[0] ?? DEFAULT_FOLDER);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [note, setNote] = useState("");
  const [result, setResult] = useState("");
  const isGif = asset.url.toLowerCase().endsWith(".gif");
  // 当前归属一定要出现在选项里（清单可能还没拉新），默认文件夹永远在场、排最前。
  const folderOptions = Array.from(new Set([DEFAULT_FOLDER, ...folders, folder]));

  /** 这张的名字是哪来的、什么时候来的——决定还要不要再认，也防止再认悄悄盖掉人写的。 */
  const statusLine = asset.emoteNamedAt === 0
    ? "未命名：聊天时检索不到这张。点「智能识别」让模型看一眼，或在上面自己写。"
    : asset.emoteNameSource === "manual"
      ? `手动维护（${new Date(asset.emoteNamedAt).toLocaleString("zh-CN")}）——点「智能识别」会用模型的判断覆盖你写的名字`
      : `智能识别于 ${new Date(asset.emoteNamedAt).toLocaleString("zh-CN")}——名字不合适就直接改，改完算手动维护`;

  useEffect(() => {
    setLabel(asset.emoteLabel); setCaption(asset.emoteCaption); setTags(asset.emoteTags);
    setFolder(asset.emotePack[0] ?? DEFAULT_FOLDER); setDraft(""); setNote(""); setResult("");
  }, [asset]);

  const addTag = (): void => {
    const value = draft.trim();
    if (value === "" || tags.includes(value)) { setDraft(""); return; }
    setTags([...tags, value].slice(0, 12));
    setDraft("");
  };

  const save = async (): Promise<void> => {
    setBusy(true); setNote("");
    try {
      await onSave({ label: label.trim(), caption: caption.trim(), tags, pack: [folder] });
      onClose();
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const renote = async (): Promise<void> => {
    setRenaming(true); setNote(""); setResult("");
    try {
      const r = await onRename();
      if (r !== null) {
        setLabel(r.label); setCaption(r.caption); setTags(r.tags);
        setResult(`识别完成，写了名称「${r.label}」——不满意直接改，改完算手动维护；确认无误点「保存」。`);
      } else {
        // onRename 抛错：note 会写，但 renaming 要在最后关掉
      }
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setRenaming(false);
    }
  };

  return (
    <Modal onClose={onClose} label="表情名称与用法" className="esem-card">
      <div className="esem">
        <div className="esem-shot">
          {/* 真图，不是缩略示意：名称对不对只有看着原图才判得出来。 */}
          <img src={asset.url} alt={asset.emoteLabel !== "" ? asset.emoteLabel : "这张表情"} />
          {isGif && <span className="esem-gif">动图</span>}
        </div>
        <div className="esem-fields">
          <label className="esem-row">
            <span className="esem-key">名称</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={12}
              placeholder="这张图作为回复时说出口的那句话，例：我躺平了、比心" />
          </label>
          <label className="esem-row">
            <span className="esem-key">适用场景</span>
            {/* 这是一句话，不是词：单行输入框会把它截成半句，看不出自己写的对不对。 */}
            <textarea value={caption} onChange={(e) => setCaption(e.target.value)} rows={2} maxLength={60}
              placeholder="什么情况下会甩它、对谁甩，例：被夸了又不好意思承认的时候" />
          </label>
          <div className="esem-row">
            <span className="esem-key">检索标签</span>
            <div className="esem-chips">
              {tags.map((tag) => (
                <span key={tag} className="esem-chip">
                  {tag}
                  <button type="button" aria-label={`去掉 ${tag}`} onClick={() => setTags(tags.filter((t) => t !== tag))}>
                    <X size={11} />
                  </button>
                </span>
              ))}
              <input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={12}
                placeholder="添加标签，回车确认"
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); addTag(); }
                  if (e.key === "," || e.key === "，") { e.preventDefault(); addTag(); }
                }}
                onBlur={addTag} aria-label="添加检索标签" />
            </div>
          </div>

          <label className="esem-row">
            <span className="esem-key">文件夹</span>
            <select className="esem-folder-select" value={folder} onChange={(e) => setFolder(e.target.value)}
              aria-label="这张表情归入的文件夹">
              {folderOptions.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
            <span className="hint">
              每张表情只属于一个文件夹：导入的进源文件夹，其余进「默认」。改归属会把文件搬进对应的磁盘目录。
            </span>
          </label>

          <div className="esem-origin">
            <span className="hint">{statusLine}</span>
            {asset.emoteAlias.length > 0 && <span className="hint">文件原名：{asset.emoteAlias.slice(0, 3).join("、")}</span>}
            {asset.emoteUseCount > 0 && <span className="hint">已经发出 {asset.emoteUseCount} 次</span>}
          </div>

          {result !== "" && <div className="pf-comp-note ok">{result}</div>}
          {note !== "" && <div className="pf-error">{note}</div>}

          <div className="row2">
            <button type="button" className="btn sm" onClick={onClose}>取消</button>
            <button type="button" className="btn sm" disabled={busy || renaming}
              onClick={() => { void renote(); }}
              title="调用图片理解，按画面重写名称、适用场景与标签（会覆盖你刚改的内容）；已经排进当前队列的就看进度条">
              <Sparkles size={13} className={renaming ? "esem-spin" : undefined} />
              {renaming ? (queueLine ?? "排队中") : "智能识别"}
            </button>
            <button type="button" className="primary sm" disabled={busy || renaming} onClick={() => { void save(); }}>保存</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}