import { useEffect, useState } from "react";
import ToggleSwitch from "../../components/ToggleSwitch";
import { describePetShowFailure, hidePetWindow, isPetRuntime, movePetWindow, resizePetWindow, showPetWindow } from "../../lib/pet-window";
import { openExternal } from "../../lib/open-external";
import { PET_DEFAULT_SKIN, PET_HEIGHT_RATIO, PET_SKINS } from "../pet/petAssets";
import type { PetSettings } from "../../types";

const skin = PET_SKINS[PET_DEFAULT_SKIN];
const MIN_PET_SIZE = 160;
const MAX_PET_SIZE = 480;

/** 默认位：桌面模式按屏幕算，内嵌模式按主窗口视口算——两套坐标空间，别混用。 */
function defaultPosition(size: number, inline: boolean): { x: number; y: number } {
  const width = inline ? (window.innerWidth || 1920) : (window.screen?.availWidth || window.innerWidth || 1920);
  const height = inline ? (window.innerHeight || 1080) : (window.screen?.availHeight || window.innerHeight || 1080);
  return {
    x: Math.max(12, width - size - 24),
    y: Math.max(12, height - Math.round(size * PET_HEIGHT_RATIO) - 24),
  };
}

/** 设置页的桌宠卡：显示方式、开关、体型、行为与窗口控制。 */
export default function PetSection({
  pet,
  busy,
  onSave,
}: {
  pet: PetSettings | undefined;
  busy: string;
  onSave: (patch: Partial<PetSettings>) => Promise<boolean>;
}): JSX.Element {
  const [displayMode, setDisplayMode] = useState<PetSettings["displayMode"]>(pet?.displayMode ?? "desktop");
  const [enabled, setEnabled] = useState(pet?.enabled ?? true);
  const [size, setSize] = useState(pet?.size ?? 180);
  const [alwaysOnTop, setAlwaysOnTop] = useState(pet?.alwaysOnTop ?? true);
  const [randomActions, setRandomActions] = useState(pet?.randomActions ?? true);
  const [chatter, setChatter] = useState(pet?.chatter ?? true);
  const [linkContacts, setLinkContacts] = useState(pet?.linkContacts ?? true);
  const [sound, setSound] = useState(pet?.sound ?? true);
  const [lockPosition, setLockPosition] = useState(pet?.lockPosition ?? false);
  const [opacity, setOpacity] = useState(pet?.opacity ?? 100);
  const [voice, setVoice] = useState(pet?.voice ?? false);
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!pet) return;
    setDisplayMode(pet.displayMode ?? "desktop");
    setEnabled(pet.enabled);
    setSize(pet.size);
    setAlwaysOnTop(pet.alwaysOnTop);
    setRandomActions(pet.randomActions);
    setChatter(pet.chatter);
    setLinkContacts(pet.linkContacts ?? true);
    setSound(pet.sound ?? true);
    setLockPosition(pet.lockPosition ?? false);
    setOpacity(pet.opacity ?? 100);
    setVoice(pet.voice ?? false);
  }, [pet]);

  const save = async (patch: Partial<PetSettings>): Promise<boolean> => {
    const ok = await onSave(patch);
    setNote(ok ? "已保存。" : "保存失败，请重试。");
    return ok;
  };

  /** 桌面模式召唤外壳透明窗：优先回到上次拖到的位置，没存过就右下角。 */
  const summonDesktopWindow = async (): Promise<string | null> => {
    const saved = pet?.x !== undefined && pet?.y !== undefined ? { x: pet.x, y: pet.y } : null;
    const pos = saved ?? defaultPosition(size, false);
    const shown = await showPetWindow({
      url: location.origin + "/#/pet",
      x: pos.x,
      y: pos.y,
      width: size,
      height: Math.round(size * PET_HEIGHT_RATIO),
      alwaysOnTop,
    });
    return shown.ok ? null : describePetShowFailure(shown.error);
  };

  const toggleEnabled = async (next: boolean): Promise<void> => {
    setEnabled(next);
    const ok = await save({ enabled: next });
    if (!ok) return;
    if (displayMode === "in-app") {
      // 内嵌形态没有独立窗口可操作：PetHost 监听保存事件自己挂/卸。
      setNote(next ? "已保存，桌宠已显示。" : "已保存，桌宠已隐藏。");
      return;
    }
    if (!next) {
      await hidePetWindow();
      return;
    }
    const error = await summonDesktopWindow();
    setNote(error === null ? "已保存，桌宠已显示。" : error);
  };

  const commitSize = async (): Promise<void> => {
    const ok = await save({ size });
    if (ok) await resizePetWindow(size, Math.round(size * PET_HEIGHT_RATIO));
  };

  const showNow = async (): Promise<void> => {
    const ok = await save({ enabled: true, size, alwaysOnTop });
    if (!ok) return;
    setEnabled(true);
    if (displayMode === "in-app") {
      setNote("已保存，桌宠已显示。");
      return;
    }
    const error = await summonDesktopWindow();
    setNote(error === null ? "已保存，桌宠已显示。" : error);
  };

  const hideNow = async (): Promise<void> => {
    if (displayMode === "in-app") {
      // 内嵌形态走持久开关：它没有独立窗口的「本次会话隐藏」语义。
      setEnabled(false);
      await save({ enabled: false });
      return;
    }
    await hidePetWindow();
  };

  const resetPosition = async (): Promise<void> => {
    const inline = displayMode === "in-app";
    const pos = defaultPosition(size, inline);
    if (inline) {
      // 内嵌位置也存设置：PetHost 收到快照后 PetView 会移到这个位置。
      await save({ inlineX: pos.x, inlineY: pos.y });
      return;
    }
    await movePetWindow(pos.x, pos.y);
    await save({ x: pos.x, y: pos.y });
  };

  const switchMode = async (next: PetSettings["displayMode"]): Promise<void> => {
    if (next === displayMode) return;
    setDisplayMode(next);
    const ok = await save({ displayMode: next });
    if (!ok) return;
    if (next === "in-app") {
      await hidePetWindow();
      setNote("桌宠已移进主界面。");
      return;
    }
    const error = await summonDesktopWindow();
    setNote(error === null ? "桌宠已回到桌面。" : error);
  };

  // 署名外链：外壳里 target=_blank 点不动，走 open-external 让系统浏览器接手。
  const openLicenseLink = async (): Promise<void> => {
    const href = "https://github.com/PC2005-cloud/dsh-pet";
    const r = await openExternal(href);
    if (!r.ok) setNote(`${r.error} · ${href}`);
  };

  return (
    <section className="settings-panel" id="settings-pet">
      <div className="settings-panel-head">
        <h3>桌宠</h3>
        <p>在主界面里或桌面上陪伴你。拖动、点击、右键菜单都能互动；只在桌面端显示。</p>
      </div>

      <div className="settings-row">
        <div className="settings-row-label">
          <b>形象</b>
          <span>当前使用的陪伴形象与动作素材。</span>
        </div>
        <div className="pet-skin-row">
          <img className="pet-skin-preview" src={skin.portraitUrl} alt={`桌宠形象「${skin.label}」`} loading="lazy" />
          <p className="pet-skin-note">
            「{skin.label}」的动画素材来自
            <a href="https://github.com/PC2005-cloud/dsh-pet" target="_blank" rel="noreferrer"
              onClick={(e) => { e.preventDefault(); void openLicenseLink(); }}> dsh-pet </a>
            项目（CC BY-NC-SA 4.0，仅限非商业使用）；自制形象开发中，完成后可在此切换。
          </p>
        </div>
      </div>

      <div className="settings-row compact">
        <div className="settings-row-label">
          <b>显示方式</b>
          <span>桌面端内：在主界面窗口里陪伴；独立桌面：透明小窗浮在桌面上。</span>
        </div>
        <div className="seg" role="radiogroup" aria-label="桌宠显示方式">
          <button type="button" className={displayMode === "in-app" ? "on" : ""} disabled={busy !== ""}
            onClick={() => { void switchMode("in-app"); }}>桌面端内</button>
          <button type="button" className={displayMode === "desktop" ? "on" : ""} disabled={busy !== ""}
            onClick={() => { void switchMode("desktop"); }}>独立桌面</button>
        </div>
      </div>

      <div className="settings-row compact">
        <div className="settings-row-label">
          <b>显示桌宠</b>
          <span>{displayMode === "in-app" ? "开启后在主界面窗口里出现桌宠伙伴。" : "开启后在桌面右下角出现桌宠伙伴。"}</span>
        </div>
        <ToggleSwitch checked={enabled} onChange={toggleEnabled} label="显示桌宠" disabled={busy !== ""} />
      </div>

      <div className="settings-row">
        <div className="settings-row-label">
          <b>体型</b>
          <span>桌宠的宽度；高度按体型自动留出气泡与菜单空间。</span>
        </div>
        <div className="pet-size-row">
          <input
            id="pet-size"
            type="range"
            min={MIN_PET_SIZE}
            max={MAX_PET_SIZE}
            step={10}
            value={size}
            disabled={busy !== ""}
            onChange={(e) => setSize(Number(e.target.value))}
            onPointerUp={commitSize}
            onKeyUp={commitSize}
          />
          <output htmlFor="pet-size">{size}px</output>
        </div>
      </div>

      {displayMode === "desktop" && (
        <div className="settings-row compact">
          <div className="settings-row-label">
            <b>置顶显示</b>
            <span>桌宠窗口始终浮在最上层，不会被其它窗口盖住。</span>
          </div>
          <ToggleSwitch checked={alwaysOnTop} onChange={async (next) => { setAlwaysOnTop(next); await save({ alwaysOnTop: next }); }} label="置顶显示" disabled={busy !== ""} />
        </div>
      )}

      <div className="settings-row compact">
        <div className="settings-row-label">
          <b>随机动作</b>
          <span>闲下来会自己走路、打瞌睡、工作或玩耍。</span>
        </div>
        <ToggleSwitch checked={randomActions} onChange={async (next) => { setRandomActions(next); await save({ randomActions: next }); }} label="随机动作" disabled={busy !== ""} />
      </div>

      <div className="settings-row compact">
        <div className="settings-row-label">
          <b>碎碎念</b>
          <span>每隔一段时间说一句轻松的话；点击它也会回应。</span>
        </div>
        <ToggleSwitch checked={chatter} onChange={async (next) => { setChatter(next); await save({ chatter: next }); }} label="碎碎念" disabled={busy !== ""} />
      </div>

      <div className="settings-row compact">
        <div className="settings-row-label">
          <b>消息联动</b>
          <span>小茉回复时进入工作状态；联系人来消息时提示，气泡存续期内点它直达会话。</span>
        </div>
        <ToggleSwitch checked={linkContacts} onChange={async (next) => { setLinkContacts(next); await save({ linkContacts: next }); }} label="消息联动" disabled={busy !== ""} />
      </div>

      <div className="settings-row compact">
        <div className="settings-row-label">
          <b>点击音效</b>
          <span>戳桌宠时来一声轻快的 pop。</span>
        </div>
        <ToggleSwitch checked={sound} onChange={async (next) => { setSound(next); await save({ sound: next }); }} label="点击音效" disabled={busy !== ""} />
      </div>

      <div className="settings-row compact">
        <div className="settings-row-label">
          <b>锁定位置</b>
          <span>桌宠不再被拖来拖去，点击反应保留。</span>
        </div>
        <ToggleSwitch checked={lockPosition} onChange={async (next) => { setLockPosition(next); await save({ lockPosition: next }); }} label="锁定位置" disabled={busy !== ""} />
      </div>

      <div className="settings-row">
        <div className="settings-row-label">
          <b>不透明度</b>
          <span>桌宠的浓淡；太淡就快看不见了，最低 30。</span>
        </div>
        <div className="pet-size-row">
          <input
            id="pet-opacity"
            type="range"
            min={30}
            max={100}
            step={5}
            value={opacity}
            disabled={busy !== ""}
            onChange={(e) => setOpacity(Number(e.target.value))}
            onPointerUp={async () => { await save({ opacity }); }}
            onKeyUp={async () => { await save({ opacity }); }}
          />
          <output htmlFor="pet-opacity">{opacity}%</output>
        </div>
      </div>

      <div className="settings-row compact">
        <div className="settings-row-label">
          <b>桌宠语音</b>
          <span>碎碎念和戳它时把话念出来；需要先在「模型与能力」里配好语音合成，未配置时只显示文字气泡。</span>
        </div>
        <ToggleSwitch checked={voice} onChange={async (next) => { setVoice(next); await save({ voice: next }); }} label="桌宠语音" disabled={busy !== ""} />
      </div>

      <div className="settings-foot">
        <button type="button" className="btn sm" disabled={busy !== ""} onClick={showNow}>立即显示</button>
        <button type="button" className="btn sm ghost" disabled={busy !== ""} onClick={hideNow}>隐藏桌宠</button>
        <button type="button" className="btn sm ghost" disabled={busy !== ""} onClick={resetPosition}>回到右下角</button>
        <span className="hint">{isPetRuntime() ? "桌宠窗口与主界面共用同一份设置。" : "桌宠只在桌面端显示。"}</span>
      </div>
      {note && <div className="inline-note">{note}</div>}
    </section>
  );
}
