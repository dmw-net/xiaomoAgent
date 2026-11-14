import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Blocks, ChevronRight, Database, Images, Info, Palette, PawPrint, Search, SearchX, Sparkles, UserRound, X, type LucideIcon } from "lucide-react";
import Tabs, { panelAria } from "../../components/Tabs";
import TabPanel from "../../components/TabPanel";
import Modal from "../../components/Modal";
import AboutBody from "../../components/AboutBody";
import EmptyState from "../../components/EmptyState";
import ModelSection from "./ModelSection";
import CapabilitySection from "./CapabilitySection";
import ToolsWorkbench from "./ToolsWorkbench";
import MediaSection from "./MediaSection";
import OwnerSection from "./OwnerSection";
import AppearanceSection from "./AppearanceSection";
import PetSection from "./PetSection";
import { useSettingsForm } from "./useSettingsForm";
import { useNarrow } from "../../hooks/useNarrow";

/** 外部仍按目的地传 tab；`home` 是 Rail 进入设置时的落地页。 */
export type SettingsTab =
  | "home"
  | "owner"
  | "model"
  | "capability"
  | "skill"
  | "tools"
  | "media"
  | "pet"
  | "appearance"
  | "about"
  | "experience"
  | "system";

type SettingsGroup = "owner" | "model" | "tools" | "media" | "pet" | "experience" | "system" | "about";
type ModelTab = "model" | "capability";

type GroupDef = {
  key: SettingsGroup;
  label: string;
  hint: string;
  icon: LucideIcon;
};

/** 顶层按用户要解决的事情分类，而不是按实现模块分类。 */
const GROUPS: GroupDef[] = [
  { key: "owner", label: "我的资料", hint: "头像、称呼与联系人眼中的你", icon: UserRound },
  { key: "model", label: "模型与能力", hint: "主对话模型、专项能力端点", icon: Sparkles },
  { key: "tools", label: "工具与扩展", hint: "开关总览、技能、扩展与 MCP", icon: Blocks },
  { key: "media", label: "媒体与表情", hint: "图片、视频、语音，以及表情包", icon: Images },
  { key: "pet", label: "桌宠", hint: "桌面透明小窗、互动与显示位置", icon: PawPrint },
  { key: "experience", label: "体验与提醒", hint: "外观、聊天显示与通知", icon: Palette },
  { key: "system", label: "系统与数据", hint: "存储、备份、访问与启动", icon: Database },
  { key: "about", label: "关于", hint: "版本、许可与项目信息", icon: Info },
];

/** 侧栏的段标题：只做视觉分区，不引入第二层导航（点击仍直达分组）。
 *  按改动频率排：常看 → 常改 → 低频且含危险操作，与底部「系统区」文案呼应。 */
const NAV_SECTIONS: Array<{ label: string; keys: Array<SettingsGroup> }> = [
  { label: "通用", keys: ["owner", "experience"] },
  { label: "能力", keys: ["model", "tools", "media", "pet"] },
  { label: "系统", keys: ["system", "about"] },
];
const GROUP_BY_KEY = new Map(GROUPS.map((item) => [item.key, item] as const));

const MODEL_TABS: Array<{ key: ModelTab; label: string }> = [
  { key: "model", label: "主对话模型" },
  { key: "capability", label: "能力模型" },
];

type SearchEntry = {
  group: SettingsGroup;
  modelTab?: ModelTab;
  title: string;
  meta: string;
  anchor: string;
  keywords: string;
  /** 目的地在设置页之外时的特殊动作；目前只有召唤设置助手并落到它的设置屏。 */
  action?: "assistant";
  /** 作用域角标的覆盖文案（助手不住在七个分组里，不硬塞分组名）。 */
  scope?: string;
};

/** 设置搜索只索引“用户能认出的对象”，不把控件名和解释堆成一张完整目录。 */
const SEARCH_ENTRIES: SearchEntry[] = [
  { group: "owner", title: "我的资料", meta: "头像、称呼、指代方式、印象与备注", anchor: "settings-owner", keywords: "名字 昵称 头像 QQ 个人 人设 我" },
  // 设置助手不住在设置页的七个分组里（它是召唤层，权限档是它唯一的自有决策），
  // 但搜索必须能找到它——「权限」「自主」这类词的落点在这里，而不是工具台账。
  { group: "tools", action: "assistant", scope: "助手", title: "设置助手权限", meta: "只读 / 变更前确认 / 完全自主，对所有助手会话生效", anchor: "", keywords: "助手 设置 权限 完全自主 自主 只读 确认 信任 代理 assistant" },
  { group: "model", modelTab: "model", title: "主对话模型", meta: "供应商、接口地址、API Key、模型列表", anchor: "settings-models", keywords: "模型 大模型 接口 密钥 供应商 deepseek 火山 ollama 思考 参数" },
  { group: "model", modelTab: "capability", title: "能力模型", meta: "看图、听音、说话、画图、记忆检索", anchor: "settings-capabilities", keywords: "视觉 语音 识别 合成 图像 生成 向量 能力" },
  { group: "tools", title: "工具与扩展总览", meta: "全局档位（含全关）、逐项开关、按联系人例外", anchor: "settings-tools-overview", keywords: "工具 扩展 开关 总览 台账 档位 总闸 全关 门控 矩阵 插拔 权限" },
  { group: "tools", title: "工具循环轮次", meta: "全局模型轮次、自定义与速度取舍", anchor: "settings-tool-loop", keywords: "工具 调用 轮次 循环 模型请求 上限 重试 多步 超时" },
  { group: "media", title: "发表情频率", meta: "自然、少发或主动，只影响聊天表达倾向", anchor: "settings-emote-frequency", keywords: "表情 表情包 发表情 频率 主动 少发 接梗 情绪" },
  { group: "tools", title: "技能", meta: "SKILL.md、技能目录、重新扫描", anchor: "settings-skills", keywords: "技能 skill 提示词 工具 目录" },
  { group: "tools", title: "扩展与 MCP", meta: "MCP、Webhook、JS 工具、脚本许可", anchor: "settings-extensions", keywords: "扩展 mcp webhook 脚本 js 插件 工具" },
  { group: "media", title: "媒体与表情", meta: "图片、视频、语音，以及表情包", anchor: "settings-media", keywords: "表情 表情包 emoji sticker 素材 采集 导入 相册 图片 视频 语音 文件 媒体 接梗 反应 内容库" },
  { group: "experience", title: "外观与壁纸", meta: "浅色、深色、强调色、壁纸", anchor: "settings-appearance", keywords: "主题 颜色 强调色 壁纸 玻璃 背景" },
  { group: "experience", title: "聊天显示", meta: "气泡时间、生成速度、语音播放按钮、列表密度", anchor: "settings-chat-display", keywords: "时间 日期 密度 列表 气泡 速度 t/s 语音 播放 tts 读出来" },
  { group: "experience", title: "系统通知", meta: "新消息通知与权限", anchor: "settings-notifications", keywords: "通知 提醒 消息 权限" },
  { group: "system", title: "数据存储", meta: "数据目录与迁移", anchor: "settings-storage", keywords: "数据 文件夹 目录 存储 迁移" },
  { group: "system", title: "隐私与数据边界", meta: "本机数据、模型发送范围与运行检查", anchor: "settings-privacy", keywords: "隐私 安全 密钥 本机 发送 检查 诊断" },
  { group: "system", title: "备份与恢复", meta: "导出、下载与导入备份", anchor: "settings-backup", keywords: "备份 恢复 导出 导入 迁移 恢复" },
  { group: "system", title: "手机与远程访问", meta: "局域网、访问码、隧道域名", anchor: "settings-lan", keywords: "手机 局域网 wifi 远程 隧道 二维码 访问码 端口" },
  { group: "system", title: "启动与关窗", meta: "开机自启、托盘常驻", anchor: "settings-desktop", keywords: "启动 开机 托盘 关窗 后台" },
  { group: "pet", title: "桌宠", meta: "显示、体型、随机动作与碎碎念", anchor: "settings-pet", keywords: "桌宠 宠物 透明 桌面 拖动 交互" },
  { group: "about", title: "关于小茉", meta: "版本、许可与项目信息", anchor: "settings-about", keywords: "版本 更新 许可 license 项目 关于" },
];

function groupOf(tab: SettingsTab): SettingsGroup {
  if (tab === "owner" || tab === "home") return "owner";
  if (tab === "model" || tab === "capability") return "model";
  // 旧的 "skill" 目的地仍落到新的一级分组：状态页 / 助手那些跳转不用跟着改。
  if (tab === "tools" || tab === "skill") return "tools";
  if (tab === "media") return "media";
  if (tab === "pet") return "pet";
  if (tab === "appearance" || tab === "experience") return "experience";
  if (tab === "system") return "system";
  return "about";
}

function modelTabOf(tab: SettingsTab): ModelTab {
  return tab === "capability" ? "capability" : "model";
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
export default function SettingsView({ onChanged, initialTab, navSeq = 0, revealAdvanced, focusProfile, toolsFocus: incomingToolsFocus, onOwnerAvatar, loadError, onRetryLoad }: {
  onChanged: () => void;
  initialTab?: SettingsTab;
  /** 导航意图序号：同目的地再次跳转（点头像回「我的资料」）也要生效，光靠 initialTab 相等不行。 */
  navSeq?: number;
  /** 外部（上下文提示「去设置」）要求展开模型档的高级参数。 */
  revealAdvanced?: boolean;
  /** 外部指定的模型档：上下文圆环知道自己量的是哪一档，要直接落到它（空串=没有指定）。 */
  focusProfile?: string;
  /** 外部（xiaomo:open-settings 事件）指定的「工具与扩展」内部页签；seq 递增保证重复跳转也生效。 */
  toolsFocus?: { tab: "overview" | "skills" | "extensions"; seq: number };
  onOwnerAvatar: (dataUrl: string) => void;
  /** 设置加载失败时的错误提示（null = 无错误）。 */
  loadError?: string | null;
  /** 重试加载设置的回调。 */
  onRetryLoad?: () => void;
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
  /** 搜索命中工具分区时把内部页签一起带过去：锚点可能在非默认页签里。 */
  const [toolsFocus, setToolsFocus] = useState<{ tab: "overview" | "skills" | "extensions"; seq: number }>(
    () => ({ tab: "overview", seq: 0 }),
  );
  /** 「我的资料」有没有未保存的改动（OwnerSection 上报）。切走分组前要拦一句。 */
  const [ownerDirty, setOwnerDirty] = useState(false);
  /** 待确认的分组切换：ownerDirty 时先弹确认，用户放弃才放行（对齐 ProfileView 的离开拦截）。 */
  const [ownerLeaveAsk, setOwnerLeaveAsk] = useState<{ go: () => void } | null>(null);

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

  // 外部指定的工具分区页签（联系人页「管理技能」等入口）：seq 变了即使页签相同也要生效。
  useEffect(() => {
    if (incomingToolsFocus !== undefined) setToolsFocus(incomingToolsFocus);
  }, [incomingToolsFocus]);

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

  /** 「我的资料」有未保存改动时，页内切走分组先问一句；确认放弃才把表单灌回快照。
      只拦页内切换——外部导航（navSeq 那条）带着明确意图（「去设置」跳转），不该被表单挡路。 */
  const leaveOwnerGuard = (go: () => void): void => {
    if (ownerDirty) setOwnerLeaveAsk({ go });
    else go();
  };

  const goToGroup = (next: SettingsGroup): void => {
    const go = (): void => {
      setGroup(next);
      setMobileHub(false);
      setQuery("");
    };
    // 点当前分组只是清掉搜索/回总览，不算离开，不拦。
    if (next === group) { go(); return; }
    leaveOwnerGuard(go);
  };

  /** 总览卡里的「去改」：只换落点，不复制任何开关，避免两处状态打架。 */
  const goToTarget = (next: SettingsGroup, tab?: ModelTab, anchor?: string): void => {
    const go = (): void => {
      setGroup(next);
      if (next === "model" && tab !== undefined) setModelTab(tab);
      setMobileHub(false);
      setQuery("");
      if (anchor !== undefined && anchor !== "") setPendingAnchor(anchor);
    };
    if (next === group) { go(); return; }
    leaveOwnerGuard(go);
  };

  const jumpTo = (entry: SearchEntry): void => {
    if (entry.action === "assistant") {
      // 跨出设置页的目的地：召唤助手弹窗并让它直接落到「助手设置」屏。
      // App 收到事件后置 open + 递增 settingsSeq；本页不清滚动位（弹窗是覆盖层）。
      setQuery("");
      window.dispatchEvent(new CustomEvent("xiaomo:open-assistant", { detail: { settings: true } }));
      return;
    }
    const go = (): void => {
      setGroup(entry.group);
      if (entry.modelTab) setModelTab(entry.modelTab);
      if (entry.group === "tools") {
        const tab = entry.anchor === "settings-skills" ? "skills"
          : entry.anchor === "settings-extensions" ? "extensions" : "overview";
        setToolsFocus((prev) => ({ tab, seq: prev.seq + 1 }));
      }
      setMobileHub(false);
      setQuery("");
      setPendingAnchor(entry.anchor);
    };
    if (entry.group === group) { go(); return; }
    leaveOwnerGuard(go);
  };

  // 优先显示 App 层传入的加载错误（初始读取失败），再显示 form 层的错误（保存后重新加载失败）
  const effectiveLoadError = loadError ?? form.loadErr;
  const effectiveRetry = loadError ? onRetryLoad : form.reload;

  if (effectiveLoadError) return (
    <div id="settings" ref={rootRef}>
      <div className="head-row"><div className="t"><h1>设置</h1></div></div>
      <div className="banner show bad" role="alert"><div className="body">
        设置没读出来：{effectiveLoadError}{" "}
        <button type="button" className="chip" onClick={effectiveRetry}>重试</button>
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
        /* 侧栏搜索无命中：窄栏里的空态，compact；主文案带关键词，指引放 hint。 */
        <EmptyState compact icon={<SearchX size={18} strokeWidth={1.5} />}
          title={`没有找到“${query.trim()}”`} hint="换个词试试，或从下方分类进入。" />
      ) : (
        searchResults.map((entry) => (
          <button key={entry.group + ":" + entry.anchor} type="button" className="settings-search-result" onClick={() => jumpTo(entry)}>
            <span>
              <b>{entry.title}</b>
              <small>{entry.meta}</small>
            </span>
            <span className="settings-search-scope">{entry.scope ?? groupLabel(entry.group)}</span>
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
          {NAV_SECTIONS.flatMap((section) => [
            <div className="settings-nav-label" key={"label-" + section.label}>{section.label}</div>,
            <nav className="settings-nav-list" aria-label={section.label} key={"list-" + section.label}>
              {section.keys.map((key) => {
                const item = GROUP_BY_KEY.get(key);
                if (!item) return null;
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
            </nav>,
          ])}
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
          <ModelSection form={form} revealAdvanced={revealAdvanced} focusProfile={focusProfile} focusSeq={navSeq} />
        </TabPanel>
      ) : null}
      {visitedModelTabs.has("capability") || modelTab === "capability" ? (
        <TabPanel active={modelTab === "capability"} aria={panelAria("set-model", "capability")}>
          <CapabilitySection form={form} />
        </TabPanel>
      ) : null}
    </>
  );

  const toolsContent = (
    <ToolsWorkbench
      form={form}
      ask={form.askDangerous}
      focus={toolsFocus}
      onGoModel={() => goToTarget("model", "model", "settings-models")}
      onGoCapability={() => goToTarget("model", "capability", "settings-capabilities")}
      onGoMedia={() => goToTarget("media", undefined, "settings-emote-frequency")}
    />
  );

  return (
    <div id="settings" ref={rootRef}>
      <div className={"head-row" + (narrow && !mobileHub ? " settings-detail-head" : "")}>
        {narrow && !mobileHub ? (
          /* 窄屏返回分类总览同样会离开「我的资料」，一并拦。 */
          <button type="button" className="settings-back" onClick={() => leaveOwnerGuard(() => setMobileHub(true))} aria-label="返回设置分类">
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

      {/* 重置/全部清空的结果不再渲染就地 banner（原 resetBanner）：按钮在系统页、
          用户确认完常立刻切分组，绑在任何分区上的提示都会跟着卸载。
          成败统一走全局 toast（useSettingsForm 内 offerToast），哪一页都看得见。 */}

      {narrow && mobileHub ? (
        <div className="settings-hub">
          <div className="settings-hub-search">{searchBox}{searchList}</div>
          {query.trim() === "" && (
            <div className="settings-hub-list">
              {NAV_SECTIONS.flatMap((section) => [
                <div className="settings-nav-label" key={"hub-label-" + section.label}>{section.label}</div>,
                section.keys.map((key) => {
                  const item = GROUP_BY_KEY.get(key);
                  if (!item) return null;
                  const Icon = item.icon;
                  return (
                    <button key={"hub-" + item.key} type="button" className="settings-hub-item" onClick={() => goToGroup(item.key)}>
                      <span className="settings-nav-icon" aria-hidden="true"><Icon size={18} strokeWidth={1.8} /></span>
                      <span className="settings-nav-copy"><b>{item.label}</b><small>{item.hint}</small></span>
                      <ChevronRight size={16} aria-hidden="true" />
                    </button>
                  );
                }),
              ])}
              <p className="settings-hub-note">先在分类里找到要改的事；进入后只显示这一组设置。</p>
            </div>
          )}
        </div>
      ) : (
        <div className="settings-layout">
          {!narrow && nav}
          <div className="set-body">
            {groupPanel("owner", <OwnerSection form={form} onOwnerAvatar={onOwnerAvatar} onDirtyChange={setOwnerDirty} />)}

            {(visitedGroups.has("model") || group === "model") && groupPanel("model", modelContent)}

            {(visitedGroups.has("tools") || group === "tools") && groupPanel("tools", toolsContent)}

            {(visitedGroups.has("media") || group === "media") && groupPanel("media",
              <MediaSection active={group === "media"} form={form} />,
            )}

            {(visitedGroups.has("pet") || group === "pet") && groupPanel("pet",
              <PetSection pet={form.saved?.pet} busy={form.busy} onSave={form.savePetSettings} />,
            )}

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

      {/* 「我的资料」没保存就切分组：结构与文案对齐 ProfileView 的离开拦截。
          「放弃并切换」把表单灌回最近一次保存的快照（applySnapshot 即 fill），
          这样切回来时不会还挂着一条已经作废的脏值条。 */}
      {ownerLeaveAsk && (
        <Modal label="放弃未保存的修改？" onClose={() => setOwnerLeaveAsk(null)}>
          <div className="del-title">放弃未保存的修改？</div>
          <div className="del-note">「我的资料」的改动还没保存，切换后会回到上一次保存的样子。</div>
          <div className="del-row">
            <button type="button" className="primary" onClick={() => setOwnerLeaveAsk(null)}>继续编辑</button>
            <button type="button" className="danger" onClick={() => {
              if (form.saved) form.applySnapshot(form.saved);
              const go = ownerLeaveAsk.go;
              setOwnerLeaveAsk(null);
              go();
            }}>放弃并切换</button>
          </div>
        </Modal>
      )}
    </div>
  );
}


