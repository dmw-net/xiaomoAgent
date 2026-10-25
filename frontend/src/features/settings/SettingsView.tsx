import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, Database, Info, Palette, Search, Sparkles, UserRound, X, type LucideIcon } from "lucide-react";
import Tabs, { panelAria } from "../../components/Tabs";
import TabPanel from "../../components/TabPanel";
import Modal from "../../components/Modal";
import AboutBody from "../../components/AboutBody";
import ModelSection from "./ModelSection";
import CapabilitySection from "./CapabilitySection";
import SkillSection from "./SkillSection";
import ExtensionSection from "./ExtensionSection";
import AssistantPermissionSection from "./AssistantPermissionSection";
import OwnerSection from "./OwnerSection";
import AppearanceSection from "./AppearanceSection";
import { useSettingsForm } from "./useSettingsForm";
import { useNarrow } from "../../hooks/useNarrow";

/** 外部仍按目的地传 tab；`home` 是 Rail 进入设置时的落地页。 */
export type SettingsTab =
  | "home"
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

type GroupDef = {
  key: SettingsGroup;
  label: string;
  hint: string;
  icon: LucideIcon;
};

/** 顶层按用户要解决的事情分类，而不是按实现模块分类。 */
const GROUPS: GroupDef[] = [
  { key: "owner", label: "我的资料", hint: "头像、称呼与联系人眼中的你", icon: UserRound },
  { key: "model", label: "模型与能力", hint: "主对话、专项能力与工具", icon: Sparkles },
  { key: "experience", label: "体验与提醒", hint: "外观、聊天显示与通知", icon: Palette },
  { key: "system", label: "系统与数据", hint: "存储、备份、访问与启动", icon: Database },
  { key: "about", label: "关于", hint: "版本、许可与项目信息", icon: Info },
];

const MODEL_TABS: Array<{ key: ModelTab; label: string }> = [
  { key: "model", label: "主对话模型" },
  { key: "capability", label: "能力模型" },
  { key: "skill", label: "技能与工具" },
];

type SearchEntry = {
  group: SettingsGroup;
  modelTab?: ModelTab;
  title: string;
  meta: string;
  anchor: string;
  keywords: string;
};

/** 设置搜索只索引“用户能认出的对象”，不把控件名和解释堆成一张完整目录。 */
const SEARCH_ENTRIES: SearchEntry[] = [
  { group: "owner", title: "我的资料", meta: "头像、称呼、性别、印象与备注", anchor: "settings-owner", keywords: "名字 昵称 头像 QQ 个人 人设 我" },
  { group: "model", modelTab: "model", title: "主对话模型", meta: "供应商、接口地址、API Key、模型列表", anchor: "settings-models", keywords: "模型 大模型 接口 密钥 供应商 deepseek 火山 ollama 思考 参数" },
  { group: "model", modelTab: "capability", title: "能力模型", meta: "看图、听音、说话、画图、记忆检索", anchor: "settings-capabilities", keywords: "视觉 语音 识别 合成 图像 生成 向量 能力" },
  { group: "model", modelTab: "skill", title: "设置助手权限", meta: "只读、变更前确认、完全自主", anchor: "settings-assistant", keywords: "助手 权限 自动 确认 工具" },
  { group: "model", modelTab: "skill", title: "技能", meta: "SKILL.md、技能目录、重新扫描", anchor: "settings-skills", keywords: "技能 skill 提示词 工具 目录" },
  { group: "model", modelTab: "skill", title: "扩展与 MCP", meta: "MCP、Webhook、JS 工具、脚本许可", anchor: "settings-extensions", keywords: "扩展 mcp webhook 脚本 js 插件 工具" },
  { group: "experience", title: "外观与壁纸", meta: "浅色、深色、强调色、壁纸", anchor: "settings-appearance", keywords: "主题 颜色 强调色 壁纸 玻璃 背景" },
  { group: "experience", title: "聊天显示", meta: "气泡时间、列表密度", anchor: "settings-chat-display", keywords: "时间 日期 密度 列表 气泡" },
  { group: "experience", title: "系统通知", meta: "新消息通知与权限", anchor: "settings-notifications", keywords: "通知 提醒 消息 权限" },
  { group: "system", title: "数据存储", meta: "数据目录与迁移", anchor: "settings-storage", keywords: "数据 文件夹 目录 存储 迁移" },
  { group: "system", title: "备份与恢复", meta: "导出、下载与导入备份", anchor: "settings-backup", keywords: "备份 恢复 导出 导入 迁移 恢复" },
  { group: "system", title: "手机与远程访问", meta: "局域网、访问码、隧道域名", anchor: "settings-lan", keywords: "手机 局域网 wifi 远程 隧道 二维码 访问码 端口" },
  { group: "system", title: "启动与关窗", meta: "开机自启、托盘常驻", anchor: "settings-desktop", keywords: "启动 开机 托盘 关窗 后台" },
  { group: "about", title: "关于小茉", meta: "版本、许可与项目信息", anchor: "settings-about", keywords: "版本 更新 许可 license 项目 关于" },
];

function groupOf(tab: SettingsTab): SettingsGroup {
  if (tab === "owner" || tab === "home") return "owner";
  if (tab === "model" || tab === "capability" || tab === "skill") return "model";
  if (tab === "appearance" || tab === "experience") return "experience";
  if (tab === "system") return "system";
  return "about";
}

function modelTabOf(tab: SettingsTab): ModelTab {
  return tab === "capability" || tab === "skill" ? tab : "model";
}

function groupLabel(group: SettingsGroup): string {
  return GROUPS.find((item) => item.key === group)?.label ?? "设置";
}

/**
 * 设置视图。
 *
 * 桌面端是一张“设置地图”：左侧搜索 + 可自解释的分类导航，右侧只呈现一个任务域。
 * 手机端先看分类总览，再进入单项，避免把五组内容排成一条无限长表单。
 */
export default function SettingsView({ onChanged, initialTab, navSeq = 0, revealAdvanced, onOwnerAvatar}: {
  onChanged: () => void;
  initialTab?: SettingsTab;
  /** 导航意图序号：同目的地再次跳转（点头像回「我的资料」）也要生效，光靠 initialTab 相等不行。 */
  navSeq?: number;
  /** 外部（上下文提示「去设置」）要求展开模型档的高级参数。 */
  revealAdvanced?: boolean;
  onOwnerAvatar: (dataUrl: string) => void;
}): JSX.Element {
  const form = useSettingsForm(onChanged);
  const narrow = useNarrow();
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [group, setGroup] = useState<SettingsGroup>(() => groupOf(initialTab ?? "home"));
  const [modelTab, setModelTab] = useState<ModelTab>(() => modelTabOf(initialTab ?? "model"));
  const [mobileHub, setMobileHub] = useState<boolean>(() => (initialTab ?? "home") === "home");
  const [query, setQuery] = useState("");
  const [pendingAnchor, setPendingAnchor] = useState("");
  const [visitedGroups, setVisitedGroups] = useState<Set<SettingsGroup>>(
    () => new Set([groupOf(initialTab ?? "home")]),
  );
  const [visitedModelTabs, setVisitedModelTabs] = useState<Set<ModelTab>>(
    () => new Set([modelTabOf(initialTab ?? "home")]),
  );

  const searchTerm = query.trim().toLocaleLowerCase();
  const searchResults = searchTerm === ""
    ? []
    : SEARCH_ENTRIES.filter((entry) => `${entry.title} ${entry.meta} ${entry.keywords}`.toLocaleLowerCase().includes(searchTerm));

  // 外部请求切换目的地（如点左上角头像直达「我的资料」、首页卡片直达能力模型）。
  // navSeq 变了即使 initialTab 相同也要重新落位。
  useEffect(() => {
    const next = initialTab ?? "home";
    setGroup(groupOf(next));
    if (groupOf(next) === "model") setModelTab(modelTabOf(next));
    setMobileHub(next === "home");
    setQuery("");
  }, [initialTab, navSeq]);

  useEffect(() => {
    setVisitedGroups((prev) => prev.has(group) ? prev : new Set(prev).add(group));
  }, [group]);

  useEffect(() => {
    setVisitedModelTabs((prev) => prev.has(modelTab) ? prev : new Set(prev).add(modelTab));
  }, [modelTab]);

  // 切分类是“换一页”，不是继续停在上一页的滚动位置。
  useEffect(() => {
    if (narrow && mobileHub) return;
    const scroller = rootRef.current?.closest(".view");
    scroller?.scrollTo({ top: 0, behavior: "auto" });
  }, [group, modelTab, mobileHub, narrow]);

  // 搜索命中后滚到具体设置卡，而不是只把用户送到分类的第一张卡。
  useEffect(() => {
    if (pendingAnchor === "") return;
    const raf = requestAnimationFrame(() => {
      const target = document.getElementById(pendingAnchor);
      target?.scrollIntoView({ block: "start", behavior: "smooth" });
      setPendingAnchor("");
    });
    return () => cancelAnimationFrame(raf);
  }, [pendingAnchor, group, modelTab, mobileHub]);

  const goToGroup = (next: SettingsGroup): void => {
    setGroup(next);
    setMobileHub(false);
    setQuery("");
  };

  const jumpTo = (entry: SearchEntry): void => {
    setGroup(entry.group);
    if (entry.modelTab) setModelTab(entry.modelTab);
    setMobileHub(false);
    setQuery("");
    setPendingAnchor(entry.anchor);
  };

  if (form.loadErr) return (
    <div id="settings" ref={rootRef}>
      <div className="head-row"><div className="t"><h1>设置</h1></div></div>
      <div className="banner show bad" role="alert"><div className="body">
        设置没读出来：{form.loadErr}{" "}
        <button type="button" className="chip" onClick={form.reload}>重试</button>
      </div></div>
    </div>
  );

  const searchBox = (
    <div className="settings-search" role="search">
      <Search size={15} aria-hidden="true" />
      <input
        ref={searchRef}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setQuery("");
          if (event.key === "Enter" && searchResults[0]) jumpTo(searchResults[0]);
        }}
        placeholder="搜索设置，例如壁纸、API Key"
        aria-label="搜索设置"
      />
      {query !== "" && (
        <button type="button" className="settings-search-clear" aria-label="清空搜索" onClick={() => setQuery("")}>
          <X size={14} />
        </button>
      )}
    </div>
  );

  const searchList = query.trim() !== "" && (
    <div className="settings-search-results" role="region" aria-label="设置搜索结果" aria-live="polite">
      {searchResults.length === 0 ? (
        <div className="settings-search-empty">没有找到“{query.trim()}”。换个词试试，或从下方分类进入。</div>
      ) : (
        searchResults.map((entry) => (
          <button key={entry.group + ":" + entry.anchor} type="button" className="settings-search-result" onClick={() => jumpTo(entry)}>
            <span>
              <b>{entry.title}</b>
              <small>{entry.meta}</small>
            </span>
            <span className="settings-search-scope">{groupLabel(entry.group)}</span>
          </button>
        ))
      )}
    </div>
  );

  const nav = (
    <aside className="settings-nav" aria-label="设置分类">
      {searchBox}
      {query.trim() !== "" ? searchList : (
        <>
          <div className="settings-nav-label">按用途</div>
          <nav className="settings-nav-list">
            {GROUPS.map((item) => {
              const Icon = item.icon;
              return (
                <button key={item.key} type="button" aria-current={group === item.key ? "page" : undefined}
                  className={"settings-nav-item" + (group === item.key ? " on" : "")}
                  onClick={() => goToGroup(item.key)}>
                  <span className="settings-nav-icon" aria-hidden="true"><Icon size={16} strokeWidth={1.8} /></span>
                  <span className="settings-nav-copy"><b>{item.label}</b><small>{item.hint}</small></span>
                  <ChevronRight className="settings-nav-arrow" size={14} aria-hidden="true" />
                </button>
              );
            })}
          </nav>
          <p className="settings-nav-foot">常用项都已前置；密钥、备份与危险操作集中在系统区。</p>
        </>
      )}
    </aside>
  );

  const groupPanel = (key: SettingsGroup, children: JSX.Element): JSX.Element => (
    <TabPanel active={group === key} aria={{}} className={"settings-group-panel settings-group-" + key}>
      {children}
    </TabPanel>
  );

  const modelContent = (
    <>
      <div className="set-subnav">
        <Tabs base="set-model" value={modelTab} onChange={setModelTab} tabs={MODEL_TABS} />
      </div>
      {visitedModelTabs.has("model") || modelTab === "model" ? (
        <TabPanel active={modelTab === "model"} aria={panelAria("set-model", "model")}>
          <ModelSection form={form} revealAdvanced={revealAdvanced} />
        </TabPanel>
      ) : null}
      {visitedModelTabs.has("capability") || modelTab === "capability" ? (
        <TabPanel active={modelTab === "capability"} aria={panelAria("set-model", "capability")}>
          <CapabilitySection form={form} />
        </TabPanel>
      ) : null}
      {visitedModelTabs.has("skill") || modelTab === "skill" ? (
        <TabPanel active={modelTab === "skill"} aria={panelAria("set-model", "skill")}>
          <AssistantPermissionSection />
          <SkillSection ask={form.askDangerous} />
          <ExtensionSection ask={form.askDangerous} />
        </TabPanel>
      ) : null}
    </>
  );

  return (
    <div id="settings" ref={rootRef}>
      <div className={"head-row" + (narrow && !mobileHub ? " settings-detail-head" : "")}>
        {narrow && !mobileHub ? (
          <button type="button" className="settings-back" onClick={() => setMobileHub(true)} aria-label="返回设置分类">
            <ArrowLeft size={18} />
          </button>
        ) : null}
        <div className="t">
          <h1>{narrow && !mobileHub ? groupLabel(group) : "设置"}</h1>
          {!narrow && <p className="settings-tagline">只调整你真正需要的东西，其他都留在默认值。</p>}
        </div>
        {group === "system" && !(narrow && mobileHub) && (
          <div className="settings-danger-actions">
            <button type="button" className="btn sm danger" id="btn-factory-reset" disabled={form.busy !== ""}
              onClick={form.factoryResetAll}>全部清空</button>
            <button type="button" className="btn sm ghost" id="btn-reset" disabled={form.busy !== ""}
              onClick={form.resetAll}>重置设置</button>
          </div>
        )}
      </div>

      {narrow && mobileHub ? (
        <div className="settings-hub">
          <div className="settings-hub-search">{searchBox}{searchList}</div>
          {query.trim() === "" && (
            <div className="settings-hub-list">
              <div className="settings-nav-label">按用途</div>
              {GROUPS.map((item) => {
                const Icon = item.icon;
                return (
                  <button key={item.key} type="button" className="settings-hub-item" onClick={() => goToGroup(item.key)}>
                    <span className="settings-nav-icon" aria-hidden="true"><Icon size={18} strokeWidth={1.8} /></span>
                    <span className="settings-nav-copy"><b>{item.label}</b><small>{item.hint}</small></span>
                    <ChevronRight size={16} aria-hidden="true" />
                  </button>
                );
              })}
              <p className="settings-hub-note">先在分类里找到要改的事；进入后只显示这一组设置。</p>
            </div>
          )}
        </div>
      ) : (
        <div className="settings-layout">
          {!narrow && nav}
          <div className="set-body">
            {groupPanel("owner", <OwnerSection form={form} onOwnerAvatar={onOwnerAvatar} />)}

            {(visitedGroups.has("model") || group === "model") && groupPanel("model", modelContent)}

            {(visitedGroups.has("experience") || group === "experience") && groupPanel("experience",
              <AppearanceSection scope="experience" dataDir={form.saved?.dataDir ?? ""} desktop={form.saved?.desktop ?? null} />,
            )}

            {(visitedGroups.has("system") || group === "system") && groupPanel("system",
              <AppearanceSection scope="system" dataDir={form.saved?.dataDir ?? ""} desktop={form.saved?.desktop ?? null} />,
            )}

            {(visitedGroups.has("about") || group === "about") && groupPanel("about",
              <div className="section sec-about" id="settings-about"><AboutBody /></div>,
            )}
          </div>
        </div>
      )}

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


