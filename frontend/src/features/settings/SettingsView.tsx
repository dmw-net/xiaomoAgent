import { useEffect, useState } from "react";
import Tabs, { panelAria } from "../../components/Tabs";
import TabPanel from "../../components/TabPanel";
import Modal from "../../components/Modal";
import AboutBody from "../../components/AboutBody";
import ModelSection from "./ModelSection";
import CapabilitySection from "./CapabilitySection";
import SkillSection from "./SkillSection";
import OwnerSection from "./OwnerSection";
import AppearanceSection from "./AppearanceSection";
import { useSettingsForm } from "./useSettingsForm";

/** 外部仍按目的地传 tab（模型、能力、界面……）；页面内部再映射到五个用户任务分组。 */
export type SettingsTab =
  | "owner"
  | "model"
  | "capability"
  | "skill"
  | "appearance"
  | "about"
  | "experience"
  | "system";

type SettingsGroup = "owner" | "model" | "experience" | "system" | "about";
type ModelTab = "model" | "capability" | "skill";

/** 顶层按用户要解决的事情分类，而不是按实现模块分类。 */
const GROUPS: Array<{ key: SettingsGroup; label: string }> = [
  { key: "owner", label: "我的资料" },
  { key: "model", label: "模型与能力" },
  { key: "experience", label: "体验与提醒" },
  { key: "system", label: "系统与数据" },
  { key: "about", label: "关于" },
];

const MODEL_TABS: Array<{ key: ModelTab; label: string }> = [
  { key: "model", label: "主对话模型" },
  { key: "capability", label: "能力模型" },
  { key: "skill", label: "技能与工具" },
];

function groupOf(tab: SettingsTab): SettingsGroup {
  if (tab === "owner") return "owner";
  if (tab === "model" || tab === "capability" || tab === "skill") return "model";
  if (tab === "appearance" || tab === "experience") return "experience";
  if (tab === "system") return "system";
  return "about";
}

function modelTabOf(tab: SettingsTab): ModelTab {
  return tab === "capability" || tab === "skill" ? tab : "model";
}

/**
 * 设置视图。顶层是五个任务分组；只有「模型与能力」需要二级导航，因为它们共享同一套
 * 服务商与密钥心智。每个分区自带保存；清空与重置只在「系统与数据」出现，不再贴着日常偏好。
 */
export default function SettingsView({ onChanged, initialTab, revealAdvanced, onOwnerAvatar}: {
  onChanged: () => void;
  initialTab?: SettingsTab;
  /** 外部（上下文提示「去设置」）要求展开模型档的高级参数。 */
  revealAdvanced?: boolean;
  onOwnerAvatar: (dataUrl: string) => void;
}): JSX.Element {
  const form = useSettingsForm(onChanged);
  const [group, setGroup] = useState<SettingsGroup>(() => groupOf(initialTab ?? "owner"));
  const [modelTab, setModelTab] = useState<ModelTab>(() => modelTabOf(initialTab ?? "model"));
  const [visitedGroups, setVisitedGroups] = useState<Set<SettingsGroup>>(
    () => new Set([groupOf(initialTab ?? "owner")]),
  );
  const [visitedModelTabs, setVisitedModelTabs] = useState<Set<ModelTab>>(
    () => new Set([modelTabOf(initialTab ?? "model")]),
  );

  // 外部请求切换目的地（如点左上角头像直达「我的资料」、首页卡片直达能力模型）。
  useEffect(() => {
    if (!initialTab) return;
    setGroup(groupOf(initialTab));
    if (groupOf(initialTab) === "model") setModelTab(modelTabOf(initialTab));
  }, [initialTab]);

  useEffect(() => {
    setVisitedGroups((prev) => prev.has(group) ? prev : new Set(prev).add(group));
  }, [group]);

  useEffect(() => {
    setVisitedModelTabs((prev) => prev.has(modelTab) ? prev : new Set(prev).add(modelTab));
  }, [modelTab]);

  if (form.loadErr) return (
    <div id="settings">
      <div className="head-row"><div className="t"><h1>设置</h1></div></div>
      <div className="banner show bad" role="alert"><div className="body">
        设置没读出来：{form.loadErr}{" "}
        <button type="button" className="chip" onClick={form.reload}>重试</button>
      </div></div>
    </div>
  );

  return (
    <div id="settings">
      <div className="head-row">
        <div className="t"><h1>设置</h1></div>
        {group === "system" && (
          <>
            <button type="button" className="btn sm danger" id="btn-factory-reset" disabled={form.busy !== ""}
              onClick={form.factoryResetAll}>全部清空</button>
            <button type="button" className="btn sm ghost" id="btn-reset" disabled={form.busy !== ""}
              onClick={form.resetAll}>重置设置</button>
          </>
        )}
      </div>

      <Tabs base="set" value={group} onChange={(next) => setGroup(next)} tabs={GROUPS} />

      <div className="set-body">
        {(visitedGroups.has("owner") || group === "owner") && (
          <TabPanel active={group === "owner"} aria={panelAria("set", "owner")}>
            <OwnerSection form={form} onOwnerAvatar={onOwnerAvatar} />
          </TabPanel>
        )}

        {(visitedGroups.has("model") || group === "model") && (
          <TabPanel active={group === "model"} aria={panelAria("set", "model")}>
            <div className="set-subnav">
              <Tabs base="set-model" value={modelTab} onChange={setModelTab} tabs={MODEL_TABS} />
            </div>
            {(visitedModelTabs.has("model") || modelTab === "model") && (
              <TabPanel active={modelTab === "model"} aria={panelAria("set-model", "model")}>
                <ModelSection form={form} revealAdvanced={revealAdvanced} />
              </TabPanel>
            )}
            {(visitedModelTabs.has("capability") || modelTab === "capability") && (
              <TabPanel active={modelTab === "capability"} aria={panelAria("set-model", "capability")}>
                <CapabilitySection form={form} />
              </TabPanel>
            )}
            {(visitedModelTabs.has("skill") || modelTab === "skill") && (
              <TabPanel active={modelTab === "skill"} aria={panelAria("set-model", "skill")}>
                <SkillSection ask={form.askDangerous} />
              </TabPanel>
            )}
          </TabPanel>
        )}

        {(visitedGroups.has("experience") || group === "experience") && (
          <TabPanel active={group === "experience"} aria={panelAria("set", "experience")}>
            <AppearanceSection scope="experience" dataDir={form.saved?.dataDir ?? ""} desktop={form.saved?.desktop ?? null} />
          </TabPanel>
        )}

        {(visitedGroups.has("system") || group === "system") && (
          <TabPanel active={group === "system"} aria={panelAria("set", "system")}>
            <AppearanceSection scope="system" dataDir={form.saved?.dataDir ?? ""} desktop={form.saved?.desktop ?? null} />
          </TabPanel>
        )}

        {(visitedGroups.has("about") || group === "about") && (
          <TabPanel active={group === "about"} aria={panelAria("set", "about")}>
            <div className="section sec-about"><AboutBody /></div>
          </TabPanel>
        )}
      </div>

      {form.ask && (
        <Modal label={form.ask.title} onClose={form.cancelAsk}>
          <div className="del-title">{form.ask.title}</div>
          <div className="del-note">{form.ask.note}</div>
          <div className="del-row">
            <button type="button" onClick={form.cancelAsk}>取消</button>
            <button type="button" className="danger" onClick={form.acceptAsk}>确认</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
