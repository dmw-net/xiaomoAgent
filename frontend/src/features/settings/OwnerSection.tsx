import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, Save, X } from "lucide-react";
import { fileToAvatarDataUrl } from "../../lib/avatar";
import QqAvatarButton from "../../components/QqAvatarButton";
import { useDismiss } from "../../hooks/useDismiss";
import type { SettingsForm } from "./useSettingsForm";

const GENDER_OPTIONS = [
  { key: "female", label: "女" },
  { key: "male", label: "男" },
  { key: "other", label: "中性" },
] as const;

/** 全局用户资料：头像 + 指代方式 + 「联系人眼中的你」三字段。联系人各自的设定在编辑资料页。 */
export default function OwnerSection({ form, onOwnerAvatar, onDirtyChange }: {
  form: SettingsForm;
  onOwnerAvatar: (dataUrl: string) => void;
  /** 脏值变化上报给 SettingsView：切走分组前要拦一句（见 SettingsView 的 leaveOwnerGuard）。 */
  onDirtyChange?: (dirty: boolean) => void;
}): JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null);
  const [avaHint, setAvaHint] = useState("");
  const [avaBusy, setAvaBusy] = useState(false);
  // 点头像=看大图（有图时）；换图走旁边那枚「更换头像」按钮
  const [avaZoom, setAvaZoom] = useState<string | null>(null);
  useDismiss(!!avaZoom, () => setAvaZoom(null));
  const avatar = form.saved?.persona?.owner?.avatar || "";
  const ownerName = form.oName.trim() || "你";

  // 脏值口径与 useSettingsForm.collectOwner 完全一致：name 落库前 trim、其余原样比对，
  // 指代方式缺省按「中性」回填——基线对不齐就会永远显示「有未保存的改动」。
  const savedOwner = form.saved?.persona?.owner;
  const ownerDirty = useMemo((): boolean => (
    form.oName.trim() !== (savedOwner?.name ?? "").trim()
    || form.oImpression !== (savedOwner?.impression ?? "")
    || form.oNotes !== (savedOwner?.notes ?? "")
    || form.oGender !== (savedOwner?.gender ?? "other")
  ), [form.oName, form.oImpression, form.oNotes, form.oGender, savedOwner]);

  useEffect(() => {
    onDirtyChange?.(ownerDirty);
  }, [onDirtyChange, ownerDirty]);

  /** 放弃改动：把表单灌回最近一次保存的快照（applySnapshot 即 useSettingsForm 的 fill）。
      快照还没到手（加载失败）时没有可回退的基线，只能等用户自己改回去。 */
  const discardOwner = (): void => {
    if (form.saved) form.applySnapshot(form.saved);
  };

  const pick = (): void => { if (!avaBusy) fileRef.current?.click(); };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || avaBusy) return;
    setAvaBusy(true);
    setAvaHint("处理中…");
    fileToAvatarDataUrl(file)
      // 注意：不能读 form.saved——那是本次渲染的闭包快照，fill 之后也不会立刻变。
      // saveOwnerAvatar 失败时已在 hook 内 toast 报因并返回 false，这里不能把
      // 成功链（换本地头像缓存、写就地提示）跑下去，否则会把没保存成的图当成已生效。
      .then((dataUrl) => form.saveOwnerAvatar(dataUrl).then((ok) => { if (ok) { onOwnerAvatar(dataUrl); setAvaHint("头像已更新，左上角与聊天里即时生效"); } }))
      .catch((err: Error) => setAvaHint("没换成：" + err.message))
      .finally(() => setAvaBusy(false));
  };

  /**
   * QQ 头像那条路要绕一下：接口给的是本地 /media 路径，而全局用户头像**只收 dataURL**
   * （见 settings.ts 的 validatePersona，以及 /api/settings 那条偏紧的传输上限）。
   * 所以同源把它取回来，交给和"手动选图"完全相同的那条 canvas 裁剪压缩，
   * 得到 128×128 的 JPEG dataURL 再走原来的保存路径——形态与尺寸都跟手选一张一样。
   * 跨源那一步由后端做掉了，这里是同源请求，canvas 也不会被污染。
   */
  const useQqAvatar = async (mediaUrl: string): Promise<void> => {
    setAvaBusy(true);
    setAvaHint("");
    try {
      const blob = await (await fetch(mediaUrl)).blob();
      const dataUrl = await fileToAvatarDataUrl(new File([blob], "qq-avatar.jpg", { type: blob.type || "image/jpeg" }));
      // saveOwnerAvatar 失败已在 hook 内 toast 报因；这里只在真保存成功时才走成功链。
      const ok = await form.saveOwnerAvatar(dataUrl);
      if (ok) {
        onOwnerAvatar(dataUrl);
        setAvaHint("头像已更新，左上角与聊天里即时生效");
      }
    } catch (err) {
      setAvaHint("没换成：" + (err as Error).message);
    } finally {
      setAvaBusy(false);
    }
  };

  return (
    <div className="section owner-section" id="settings-owner">
      <h2>我的资料</h2>
      <div className="desc">所有联系人共通的「你」；每位联系人的设定在各自资料页里。</div>
      <div className="card card-pad">
        <div className="owner-top">
          <button
            type="button"
            className={"owner-ava" + (avatar ? " has-img" : "")}
            title={avatar ? "查看头像大图" : "点击添加头像"}
            aria-label={avatar ? "查看我的头像大图" : "添加我的头像"}
            onClick={() => (avatar ? setAvaZoom(avatar) : pick())}
          >
            {avatar ? <img src={avatar} alt="" /> : (form.saved?.persona?.owner?.name || "我").slice(0, 1)}
          </button>
          <div>
            <button type="button" className="pf-ghost" disabled={avaBusy} onClick={pick}>
              <Camera size={13} strokeWidth={1.8} />{avaBusy ? "处理中…" : "更换头像"}
            </button>
            {/* 全局用户资料只收 dataURL（settings 那条传输上限也紧），所以这里不能让 QQ
                那张 /media 路径直接落库：先同源取回来，再过一遍和手动选图完全相同的
                canvas 裁剪压缩，得到的才是这条路本来要的形态。 */}
            <QqAvatarButton disabled={avaBusy} onPick={useQqAvatar} />
            <div className="owner-ava-meta">{avaHint || "点头像看大图，旁边按钮换图；会自动裁剪压缩"}</div>
          </div>
        </div>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={onFile} />
        {avaZoom && (
          <div className="img-zoom" onClick={() => setAvaZoom(null)} role="dialog" aria-modal="true"
            aria-label="头像大图" data-keep-menu>
            <img src={avaZoom} alt="头像大图" onClick={(e) => e.stopPropagation()} />
            <button type="button" aria-label="关闭" onClick={() => setAvaZoom(null)}><X size={18} /></button>
          </div>
        )}
        <div className="field">
          <label htmlFor="o-name">称呼</label>
          <input id="o-name" placeholder="叫我：老板 / 学长 / 阿樟" value={form.oName} onChange={(e) => form.setOName(e.target.value)} />
        </div>
        <div className="field">
          <label>我的指代方式</label>
          <div className="pf-gender" role="radiogroup" aria-label="我的指代方式">
            {GENDER_OPTIONS.map((g) => (
              <button key={g.key} type="button" role="radio" aria-checked={form.oGender === g.key}
                className={"pf-gender-btn" + (form.oGender === g.key ? " on" : "")}
                onClick={() => form.setOGender(g.key)}>{g.label}</button>
            ))}
            <span className="pf-gender-hint">聊天时怎么指代你；默认使用中性称呼</span>
          </div>
        </div>
        <div className="field">
          <label htmlFor="o-impression">印象</label>
          <textarea id="o-impression" rows={3} placeholder="性格、背景与近况"
            value={form.oImpression} onChange={(e) => form.setOImpression(e.target.value)} />
          <div className="hint">写在这里的，联系人每次都会看到。</div>
        </div>
        <div className="field">
          <label htmlFor="o-notes">备注</label>
          <textarea id="o-notes" rows={2} placeholder="偏好、禁忌、固定习惯"
            value={form.oNotes} onChange={(e) => form.setONotes(e.target.value)} />
          <div className="hint">这段话会作为长期记忆带进每次对话。</div>
        </div>
        <div className="owner-see" aria-label="联系人眼中的你">
          <div className="owner-see-head"><b>联系人眼中的你</b><span>保存后带入每次对话</span></div>
          <div className="owner-see-person">
            <span className={"owner-see-ava" + (avatar ? " has-img" : "")}>
              {avatar ? <img src={avatar} alt="" /> : ownerName.slice(0, 1)}
            </span>
            <span><b>{ownerName}</b><small>聊天时会按上面的指代方式称呼你</small></span>
          </div>
          <div className="owner-see-fields">
            <div><b>印象</b><p>{form.oImpression.trim() || "还没有写，只能从聊天里慢慢认识你。"}</p></div>
            <div><b>长期备注</b><p>{form.oNotes.trim() || "还没有写。偏好和禁忌不会自动记住。"}</p></div>
          </div>
          <p className="owner-see-note">这是所有联系人共享的背景；每位联系人自己的关系设定仍在各自的资料页里。</p>
        </div>
        {/* 保存结果不再渲染就地 personaBanner：绑在「我的资料」分区里，用户点完保存
            切个分组就看不见。成败统一走全局 toast（useSettingsForm.saveOwner 内
            offerToast）；这里的脏值条（ownerDirty）只负责「还没保存」这件事，
            放弃改动走 applySnapshot 不经过 saveOwner，不会误弹「已保存」。 */}
        <div className="actions">
          {/* 没有 dirty 时禁用，与资料页 ProfileView 的保存条同一口径：
              从前这里永远可点、点了也常常是空保存，反而盖住了真正的脏值。 */}
          <button type="button" className="primary" id="btn-save-owner" disabled={form.busy !== "" || !ownerDirty}
            title={ownerDirty ? undefined : "没有需要保存的改动"} onClick={form.saveOwner}>
            {form.busy === "owner" ? "保存中…" : "保存资料"}
          </button>
        </div>
        <div className="hint">想看某位联系人实际收到什么，去联系人的资料页 → 对话设置 → 提示词预览。</div>
      </div>

      {/* 脏值提示条：对齐 ProfileView 的底部保存条（pf-dock / pf-dock-note / pf-save 都是
          现成样式，sticky 贴在滚动视口底缘）。称呼/印象/备注写完不保存就切分组，
          从前既不提示也不保存——用户最容易在这里白写一段，所以改动时必须看得见。 */}
      {ownerDirty && (
        <div className="pf-dock">
          <span className="pf-dock-note" role="status">有未保存的改动</span>
          <span style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
            <button type="button" className="pf-ghost" disabled={form.busy !== ""} onClick={discardOwner}>
              放弃改动
            </button>
            <button type="button" className="pf-save" disabled={form.busy !== ""} onClick={form.saveOwner}>
              <Save size={14} strokeWidth={1.9} />{form.busy === "owner" ? "保存中…" : "保存"}
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

