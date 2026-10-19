import { useRef, useState } from "react";
import { Camera, X } from "lucide-react";
import { fileToAvatarDataUrl } from "../../lib/avatar";
import QqAvatarButton from "../../components/QqAvatarButton";
import { useDismiss } from "../../hooks/useDismiss";
import type { SettingsForm } from "./useSettingsForm";

const GENDER_OPTIONS = [
  { key: "female", label: "女" },
  { key: "male", label: "男" },
  { key: "other", label: "其他" },
] as const;

/** 全局用户资料：头像 + 性别 + 「联系人眼中的你」三字段。联系人各自的设定在编辑资料页。 */
export default function OwnerSection({ form, onOwnerAvatar }: {
  form: SettingsForm;
  onOwnerAvatar: (dataUrl: string) => void;
}): JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null);
  const [avaHint, setAvaHint] = useState("");
  const [avaBusy, setAvaBusy] = useState(false);
  // 点头像=看大图（有图时）；换图走旁边那枚「更换头像」按钮
  const [avaZoom, setAvaZoom] = useState<string | null>(null);
  useDismiss(!!avaZoom, () => setAvaZoom(null));
  const avatar = form.saved?.persona?.owner?.avatar || "";

  const pick = (): void => { if (!avaBusy) fileRef.current?.click(); };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || avaBusy) return;
    setAvaBusy(true);
    setAvaHint("处理中…");
    fileToAvatarDataUrl(file)
      // 注意：不能读 form.saved——那是本次渲染的闭包快照，fill 之后也不会立刻变
      .then((dataUrl) => form.saveOwnerAvatar(dataUrl).then(() => dataUrl))
      .then((dataUrl) => {
        onOwnerAvatar(dataUrl);
        setAvaHint("头像已更新，左上角与聊天里即时生效");
      })
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
      await form.saveOwnerAvatar(dataUrl);
      onOwnerAvatar(dataUrl);
      setAvaHint("头像已更新，左上角与聊天里即时生效");
    } catch (err) {
      setAvaHint("没换成：" + (err as Error).message);
    } finally {
      setAvaBusy(false);
    }
  };

  return (
    <div className="section">
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
          <label>我的性别</label>
          <div className="pf-gender" role="radiogroup" aria-label="我的性别">
            {GENDER_OPTIONS.map((g) => (
              <button key={g.key} type="button" role="radio" aria-checked={form.oGender === g.key}
                className={"pf-gender-btn" + (form.oGender === g.key ? " on" : "")}
                onClick={() => form.setOGender(g.key)}>{g.label}</button>
            ))}
            <span className="pf-gender-hint">聊天时怎么指代你；不选就用中性的称呼</span>
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
        {form.personaBanner && (
          <div className={"banner show " + form.personaBanner.kind} id="personaBanner" role={form.personaBanner.kind === "bad" ? "alert" : "status"}>
            <div className="body">{form.personaBanner.text}</div>
          </div>
        )}
        <div className="actions">
          <button type="button" className="primary" id="btn-save-owner" disabled={form.busy !== ""} onClick={form.saveOwner}>
            {form.busy === "owner" ? "保存中…" : "保存资料"}
          </button>
        </div>
        <div className="hint">想看某位联系人实际收到什么，去联系人的资料页 → 对话设置 → 提示词预览。</div>
      </div>
    </div>
  );
}
