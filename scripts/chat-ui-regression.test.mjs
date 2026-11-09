/**
 * 聊天消息撤回的 UI 回归测试。
 *
 * 运行：node scripts/chat-ui-regression.test.mjs
 *
 * 覆盖两个曾经真实出现的问题：
 * 1. MessageRow 在“普通消息 → 已撤回”时提前 return，跳过后面的 useMemo，
 *    React 报 error #300（Rendered fewer hooks than expected），整页白屏。
 * 2. 移动端通用 Modal 一律贴底，聊天确认框也变成底部面板；聊天里需要的是
 *    微信式居中确认卡，不能被表单类弹窗的底部面板规则带走。
 * 3. 设置助手权限的决策 UI 全站只有一份（三档 option-card + auto 风险弹窗），chip 与
 *    助手设置屏都复用它；高风险二次确认、常显红态与本轮权限快照都不能被子系统改动悄悄绕过。
 * 4. 报错 toast 不能永久挂在屏幕上，但也要给足阅读和点重试的时间。
 * 5. 设置助手里的上下文浮层必须压在弹窗之上，否则点击后看似没有反应。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { strict as assert } from "node:assert";

const rowSource = readFileSync("frontend/src/features/chat/MessageRow.tsx", "utf8");
const thinkingSource = readFileSync("frontend/src/features/chat/ThinkingBlock.tsx", "utf8");
const chatSource = readFileSync("frontend/src/features/chat/ChatView.tsx", "utf8");
const toolCardSource = readFileSync("frontend/src/features/chat/ToolCard.tsx", "utf8");
const modalSource = readFileSync("frontend/src/components/Modal.tsx", "utf8");
const experienceCss = readFileSync("frontend/src/styles/experience.css", "utf8");
const componentsCss = readFileSync("frontend/src/styles/components.css", "utf8");
const themeCss = readFileSync("frontend/src/styles/theme.css", "utf8");
const assistantDialogSource = readFileSync("frontend/src/features/assistant/AssistantDialog.tsx", "utf8");
const assistantPermissionSource = readFileSync("frontend/src/features/assistant/AssistantPermissionChip.tsx", "utf8");
// 权限档共用件（2026-11-08 收敛）：三档 option-card 与 auto 风险弹窗的全站唯一实现，
// chip 与助手设置屏（AssistantConsole）都从这里取——同一个决策只允许一份实现、一份文案。
const assistantPermissionShared = readFileSync("frontend/src/features/assistant/AssistantPermission.tsx", "utf8");
const assistantConsoleSource = readFileSync("frontend/src/features/assistant/AssistantConsole.tsx", "utf8");
const assistantPendingSource = readFileSync("frontend/src/features/assistant/PendingCard.tsx", "utf8");
const settingsSource = readFileSync("frontend/src/features/settings/SettingsView.tsx", "utf8");
const agentSource = readFileSync("src/chat/agent.ts", "utf8");
const toolsSource = readFileSync("src/mind/tools.ts", "utf8");
const assistantSource = readFileSync("src/mind/assistant.ts", "utf8");
const noticesSource = readFileSync("frontend/src/hooks/useNotices.ts", "utf8");

const retractBranch = rowSource.indexOf('if (m.superseded_kind === "retract")');
assert(retractBranch >= 0, "MessageRow 应保留已撤回分支");

const hookCalls = [...rowSource.matchAll(/\buse(?:State|Effect|LayoutEffect|Memo|Ref|Callback|LongPress)\s*\(/g)]
  .map((match) => match.index ?? -1)
  .filter((index) => index >= 0);
assert(hookCalls.length > 0, "MessageRow 应至少调用一个 Hook");
const lastHook = Math.max(...hookCalls);
assert(
  retractBranch > lastHook,
  "已撤回分支必须排在所有 Hook 之后，否则普通消息切成已撤回时会因 Hook 数变化白屏",
);

// 用户端文案与代码统一使用中性称呼：未设置性别时不得默认写成她/他。
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
const frontendSources = walk("frontend/src").filter((path) => /\.(ts|tsx)$/.test(path));
const genderedCopy = frontendSources.filter((path) =>
  /她|(?<!其)他(?!人)/u.test(readFileSync(path, "utf8")));
assert.equal(genderedCopy.length, 0, `用户端源码不应再出现固定性别指代：${genderedCopy.join(", ")}`);

assert(!rowSource.includes('<details className="think">'), "思考过程不应再使用原生 details 的旧样式");
assert(/<ThinkingBlock\s+reasoning=\{m\.reasoning\}/.test(rowSource), "她的消息应通过 ThinkingBlock 渲染 reasoning");
assert(/aria-expanded=\{expanded\}/.test(thinkingSource), "思考过程必须暴露展开/收起状态");
assert(/aria-controls=\{bodyId\}/.test(thinkingSource) && /role="region"/.test(thinkingSource), "思考详情必须有可访问的关联区域");
assert(/renderMd\(reasoning\)/.test(thinkingSource), "思考正文应复用 Markdown 渲染，而不是输出一整块纯文本");
assert(/\.think-content\s*\{[\s\S]*?max-height:\s*min\(32vh,\s*300px\)[\s\S]*?overflow:\s*auto/.test(experienceCss), "长思考过程应限高并独立滚动");
assert(/\.think-live-dots i\s*\{[\s\S]*?animation:\s*thinkDot/.test(experienceCss), "正在思考状态应有轻量过程动效");
assert(
  /\.chat-failure\s*\{[\s\S]*?display:\s*grid[\s\S]*?grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)\s+auto[\s\S]*?"icon copy retry"[\s\S]*?"detail detail detail"/.test(experienceCss),
  "失败卡片应让文案、重试与详情各占独立网格区域，不能被长详情挤成逐字换行",
);
assert(/\.chat-failure-copy\s*\{[\s\S]*?min-width:\s*0/.test(experienceCss), "失败卡片文案区必须允许在窄屏正常收缩换行");
assert(/const thinkingLive = showThinking && thinking\?\.thinking\.mode === "on"/.test(chatSource), "只有明确开启思考时才显示正在思考状态");
assert(/const \[streamReasoning, setStreamReasoning\]/.test(chatSource), "聊天页必须单独接收流式思考草稿");
assert(/<ThinkingBlock reasoning=\{streamReasoning\} live=\{draftShown === ""\}/.test(chatSource), "思考到达后应先于正文渲染，首个可见正文出现后再收起，避免空白交接");
assert(/thinkingOpenTurns\[draftTurnRef\.current\]/.test(chatSource) && /thinkingOpen=\{m\.turn_id \? thinkingOpenTurns\[m\.turn_id\]/.test(chatSource), "思考展开态必须在流式草稿与定稿气泡之间沿用");
assert(/persistKey=\{draftTurnRef\.current/.test(chatSource) && /persistKey=\{m\.turn_id/.test(rowSource), "思考面板的滚动阅读位置必须在草稿与定稿之间沿用");
assert(/aria-busy=\{live\}/.test(thinkingSource), "流式思考面板必须暴露忙碌语义");
assert(/live \? "思考中" : "已完成"/.test(thinkingSource), "思考面板应区分进行中与完成态");
assert(/\.think\.is-live[\s\S]*?var\(--accent-soft\)/.test(experienceCss), "流式思考应有独立的进行中视觉层级");
assert(/\.think-state\.is-live::before[\s\S]*?animation:\s*thinkPulse/.test(experienceCss), "思考进行中状态应有轻量脉冲");
assert(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.think-live-dots i\s*\{\s*animation:\s*none/.test(experienceCss), "减少动效模式应关闭思考过程动画");

const voiceSource = readFileSync("frontend/src/components/VoiceMessageBubble.tsx", "utf8");
const mediaSource = readFileSync("src/media/media.ts", "utf8");
const mediaDialogSource = readFileSync("frontend/src/components/MediaMaintenanceDialog.tsx", "utf8");
const mediaLibrarySource = readFileSync("frontend/src/components/MediaLibrary.tsx", "utf8");
const profileViewSource = readFileSync("frontend/src/features/profile/ProfileView.tsx", "utf8");
const mediaSectionSource = readFileSync("frontend/src/features/settings/MediaSection.tsx", "utf8");
const settingsViewSource = readFileSync("frontend/src/features/settings/SettingsView.tsx", "utf8");
const qqSectionSource = readFileSync("frontend/src/features/profile/QQSection.tsx", "utf8");
const emoteFrequencySource = readFileSync("frontend/src/features/settings/EmoteFrequencySection.tsx", "utf8");
const outboxSource = readFileSync("frontend/src/lib/outbox.ts", "utf8");
assert(/VoiceMessageBubble/.test(rowSource) && /kind === "audio"/.test(rowSource), "语音消息必须走专用气泡，而不是当图片或普通文字渲染");
assert(/voice-wave/.test(voiceSource) && /voice-duration/.test(voiceSource) && /aria-label=\{playing \? "暂停语音消息"/.test(voiceSource), "语音气泡应包含波形、时长和可访问的播放/暂停状态");
assert(/voice-transcript/.test(voiceSource) && /Captions/.test(voiceSource), "语音转写必须可展开查看且不挤占默认气泡");
assert(/发送语音/.test(chatSource) && /finishRecording\("transcribe"\)/.test(chatSource), "录音完成后应同时保留发送语音与原转文字入口");
assert(/uploadVoice/.test(chatSource) && /attachmentMeta: \[meta\]/.test(chatSource), "语音消息应上传原始音频并随消息提交元信息");
assert(/attachment_meta/.test(mediaSource) && /saveAudio/.test(mediaSource) && /voiceMessageIdsForFile/.test(mediaSource), "媒体层必须持久化语音、建立消息来源并支持聊天级删除");
assert(/media-type-filter/.test(mediaDialogSource) && /语音/.test(mediaDialogSource), "媒体管理必须提供图片/视频/语音分类");
assert(/delete-message/.test(mediaDialogSource) && /删除语音消息/.test(mediaDialogSource), "媒体页删除语音必须使用明确确认，而不是绕过消息删文件");
assert(/attachmentMeta/.test(outboxSource), "离线发件箱必须保留语音元信息，重发后仍能渲染成语音气泡");
assert(/<FilterMenu label="类型" value={kind}/.test(mediaLibrarySource) && /kindCounts/.test(mediaLibrarySource), "媒体库必须同时支持视角与类型筛选");
assert(/<video className="content-video"/.test(mediaLibrarySource), "媒体库里的视频应可直接预览");
assert(/<VoiceMessageBubble compact/.test(mediaLibrarySource), "媒体库里的语音应可直接播放，而不是显示成普通文件");
assert(/transcript=\{a\.detail\.transcript \|\| undefined\}/.test(mediaLibrarySource), "媒体库里的语音应保留可展开的转写");
// 收敛的护栏：这一页只该有一个组件。两处界面各写一遍网格，就是「同一个删除在三处含义不同」的起点。
assert(
  !existsSync("frontend/src/features/profile/ContentLibraryPanel.tsx"),
  "旧的 ContentLibraryPanel 必须已删除——媒体清单只允许 MediaLibrary 一份实现",
);
assert(/<MediaLibrary/.test(profileViewSource), "联系人页的媒体面板应复用 MediaLibrary");
// 「表情」不再是一个入口：它是全局库上的一个标记，入口只有 设置 → 媒体与表情 一处。
assert(
  !existsSync("frontend/src/features/settings/EmoteSection.tsx"),
  "设置→表情 分区必须已删除——它和全局媒体库是同一批东西，不该有两个入口",
);
assert(/<MediaLibrary active=\{active\}/.test(mediaSectionSource), "「媒体与表情」分区应复用 MediaLibrary 作为全局库");
assert(/key: "media"/.test(settingsViewSource) && /groupPanel\("media"/.test(settingsViewSource), "媒体库必须是设置里的一级分区，不是模型下的一个子页签");
assert(!/"emote"/.test(settingsViewSource.match(/type ModelTab =[^;]+;/)?.[0] ?? ""), "模型分区的页签里不该再有「表情」");
assert(/<EmoteFrequencySection/.test(mediaSectionSource) && /发表情频率/.test(emoteFrequencySource), "表情频率应作为媒体库的全局设置，不再散落到单个联系人");
assert(!/设置 → 表情/.test(profileViewSource), "联系人功能开关的说明不该再把人指向已删除的 设置→表情");
// 命名一致性：两处是同一个库，名字必须成对改。曾经一个叫「她的东西」、一个叫「内容库」，
// 用户会以为是两个地方。
assert(/label: "媒体与表情"/.test(settingsViewSource), "设置一级分区应叫「媒体与表情」");
assert(/title="媒体"/.test(profileViewSource), "联系人页那个视角的标题应与设置侧同源（媒体）");
assert(!/她的东西|内容库/.test(mediaSectionSource + (settingsViewSource.match(/const GROUPS[^;]+;/)?.[0] ?? "")), "旧的临时命名不该还留在界面上");
assert(/markEmote/.test(mediaLibrarySource), "媒体库里要能直接把一张图设为表情包素材");

assert(
  /<Modal\s+label="操作确认"[\s\S]*?placement="center"/.test(chatSource),
  "消息操作确认框应显式使用居中 placement",
);
assert(
  /<Modal\s+label="删除确认"[\s\S]*?placement="center"/.test(chatSource),
  "消息删除确认框应显式使用居中 placement",
);
assert(/placement\?:\s*"sheet"\s*\|\s*"center"/.test(modalSource), "Modal 应暴露居中/底部面板两种 placement");
assert(/modal-overlay[\s\S]*is-center/.test(modalSource), "居中 placement 应给遮罩加稳定类名");
assert(/\.modal-overlay\.is-center\s*\{[\s\S]*?align-items:\s*center/.test(experienceCss), "移动端居中变体应覆盖贴底对齐");
assert(/\.modal-overlay\.is-center\s*>\s*\.modal-card\s*\{[\s\S]*?width:\s*min\(340px/.test(experienceCss), "移动端居中确认卡不应撑满全宽");

assert(
  /\.ctx-pop\s*\{[\s\S]*?z-index:\s*var\(--z-chat-pop\)/.test(componentsCss),
  "设置助手里的上下文浮层应使用高于弹窗的 z-index",
);
const cssZ = (name) => Number(themeCss.match(new RegExp("--" + name + ":\\s*(\\d+)"))?.[1]);
assert(cssZ("z-chat-pop") > cssZ("z-dialog"), "上下文浮层层级必须高于设置助手弹窗");
assert(
  /\.ctx-backdrop\s*\{[\s\S]*?z-index:\s*calc\(var\(--z-chat-pop\) - 1\)/.test(componentsCss),
  "上下文浮层遮罩应盖住设置助手并紧贴浮层下方",
);
assert(!settingsSource.includes("AssistantPermissionSection"), "设置页不应再渲染第二套助手权限单选卡");
assert(assistantDialogSource.includes("composerAccessory={<AssistantPermissionChip"), "权限 chip 必须挂在设置助手输入区");
// 三档定义收敛到 AssistantPermission.tsx 之后，断言跟着搬：这份文件是三档语义的唯一出处。
assert(/const PERMISSION_TIERS[\s\S]*?"readonly"[\s\S]*?"confirm"[\s\S]*?"auto"/.test(assistantPermissionShared), "权限共用件应保留只读/变更前确认/完全自主三档");
assert(/对所有设置助手会话生效/.test(assistantPermissionSource), "权限说明必须写明全局生效");
assert(/next === "auto"[\s\S]*?setConfirmAuto\(true\)/.test(assistantPermissionSource), "进入完全自主前必须二次确认");
assert(/权限变更从下一条消息开始生效/.test(assistantPermissionSource), "UI 必须说明权限从下一条消息生效");
assert(/\.asst-perm-chip\.is-auto[\s\S]*?var\(--danger\)/.test(componentsCss), "完全自主 chip 必须常显危险色");
// 收敛后的硬约束：同一个权限决策，chip 与助手设置屏必须用同一份 option-card 与同一份风险弹窗。
assert(assistantPermissionSource.includes("<AssistantTierOptions") && assistantConsoleSource.includes("<AssistantTierOptions"),
  "chip 与助手设置屏必须复用同一份三档 option-card（AssistantPermission.tsx）");
assert(assistantPermissionSource.includes("<AssistantAutoConfirmModal") && assistantConsoleSource.includes("<AssistantAutoConfirmModal"),
  "「完全自主」风险弹窗全站只能有一份（AssistantPermission.tsx），不允许两处各写一份文案");
assert(!assistantConsoleSource.includes("lg-segmented"), "助手设置屏不得再保留第二套权限分段按钮");
// 设置搜索必须能找到助手：搜「权限/助手」的落点是跨页召唤，不是工具台账。
assert(/action: "assistant"[\s\S]*?title: "设置助手权限"/.test(settingsSource), "设置搜索必须收录「设置助手权限」并标记跨页 action");
assert(assistantDialogSource.includes("settingsSeq") && /open && settingsSeq > 0/.test(assistantDialogSource),
  "搜索召唤必须能把助手弹窗直接落到设置屏（settingsSeq 落位）");
// 确认卡是理解信任模型的时刻：档位语境 + 就近调档入口必须常驻卡片。
assert(/当前档位/.test(assistantPendingSource) && assistantPendingSource.includes("xiaomo:assistant-perm-open"),
  "确认卡必须带档位语境行与「调整权限」就近入口（事件展开 chip 弹层）");
assert(assistantPermissionSource.includes("xiaomo:assistant-perm-open"),
  "权限 chip 必须响应确认卡发来的就近展开事件");
// auto 档的事后可见性：助手设置屏必须有变更记录面板，数据来自后端活动记录接口。
assert(assistantConsoleSource.includes("最近的配置变更") && assistantConsoleSource.includes("fetchActivity"),
  "助手设置屏必须有「最近的配置变更」审计面板（/api/assistant/activity）");
assert(/>\s*去处理\s*</.test(assistantConsoleSource),
  "待确认动作数字>0 时必须给「去处理」出口，不能是死端数字");
// 声明与执行共用一份「本轮工具池快照」之后，toolDefsForApi 多了第三个参数；
// 断言仍要钉住「用启动时的权限快照」，只是不再把参数个数写死。
assert(
  /assistantPermissionSnapshot/.test(agentSource)
  && /toolDefsForApi\(contactId, permissionSnapshot(?:,\s*turnTools)?\)/.test(agentSource),
  "当前轮必须使用启动时的权限快照声明工具",
);
assert(/visibleTools\(context\.contactId, context\.assistantPermission\)/.test(toolsSource), "工具执行也必须读取同一份权限快照");
assert(/context\.assistantPermission \?\? assistantPermission\(\)/.test(assistantSource), "危险动作确认策略必须跟随本轮权限快照");
assert(/INFO_NOTICE_TTL_MS\s*=\s*2600/.test(noticesSource), "信息 toast 应保留 2.6 秒自动消失");
assert(/ERROR_NOTICE_TTL_MS\s*=\s*8000/.test(noticesSource), "报错 toast 应在 8 秒后自动消失，不能永久停留");
assert(/opts\?\.info\s*&&\s*!opts\.retryTurnId\s*\?\s*INFO_NOTICE_TTL_MS\s*:\s*ERROR_NOTICE_TTL_MS/.test(noticesSource), "info 与错误 toast 必须使用各自时限，可重试提示也需自动消失");

// 设置助手的设置屏要盖住整个弹窗体，包括聊天输入区。
// 真实问题：#composer 是 z-index: --z-dock 的独立浮层，设置屏只给 1 的话输入框会从设置页底下
// 探出来（"设置页下面居然还挂着一个对话框"），还把设置页最后一行挡住。
assert(
  /\.asst-settings\s*\{[\s\S]*?z-index:\s*calc\(var\(--z-dock\) \+ 1\)/.test(componentsCss),
  "设置屏层级必须高于 --z-dock 的聊天输入区",
);
assert(cssZ("z-dock") > 0, "必须能读到 --z-dock 的取值");
assert(
  /\.asst-body\.settings-on #composer\s*\{\s*display:\s*none/.test(componentsCss),
  "设置屏打开时要把输入区收掉：只靠层级盖住的话，Tab 仍能聚焦到看不见的输入框里打字",
);
assert(
  /className=\{"asst-body" \+ \(showSettings \? " settings-on" : ""\)\}/.test(assistantDialogSource),
  "打开设置屏时必须给 asst-body 打上 settings-on",
);
assert(
  /\.asst-pending\s*\{[\s\S]*?z-index:\s*calc\(var\(--z-dock\) \+ 2\)/.test(componentsCss),
  "等待确认的卡片必须压在新的设置屏之上，否则最该被看见的时候反而消失",
);

// 候选图不是「过程」而是产出：关掉工具调用过程也得显示，否则会出现
// 「她说图已经显示在界面上、界面上什么都没有」。
assert(
  /if \(!showTools && \(m\.attachments \?\? \[\]\)\.length === 0\) continue;/.test(chatSource),
  "关掉工具调用过程时，带候选图的工具卡仍要渲染",
);
assert(/imagesOnly=\{!showTools\}/.test(chatSource), "工具卡应支持只渲染候选图（不显示卡片本身）");
assert(/if \(imagesOnly\) \{/.test(toolCardSource), "ToolCard 需要一条只出图的渲染分支");
// 表情工具曾因两处漏登记，把工具结果的原始 JSON 显示成「做了点事 · {"via":"native"...}」。
// 动作短语的真源已收口到后端 TOOL_META 的 chat 字段（经 /api/tools 下发），
// 前端不再复刻一份映射——守两件事：后端登记在 tool-catalog，前端消费 toolsStore。
const toolCatalogSource = readFileSync("src/mind/tool-catalog.ts", "utf8");
assert(/send_emote:.*chat:\s*"发了张表情"/.test(toolCatalogSource),
  "tool-catalog 要给 send_emote 登记聊天动作短语（唯一真源）");
assert(/emote_search:.*chat:\s*"翻了翻表情库"/.test(toolCatalogSource),
  "tool-catalog 要给 emote_search 登记聊天动作短语（唯一真源）");
assert(/chatLabelsOf/.test(toolCardSource) && /chatLabelsOf/.test(readFileSync("frontend/src/lib/toolsStore.ts", "utf8")),
  "ToolCard 的动作短语必须走 toolsStore 的 chatLabelsOf，不得再维护本地映射");
assert(
  toolCardSource.includes('/^\\s*[{[]/.test(rawSummary)'),
  "早期落库的 JSON 摘要要兜住，别把调试串显示给用户",
);
// 早期入站把 QQ 表情一律压成「[表情]」，历史消息里至今还留着这三个字。
// 新入站已解析成具体表情；旧数据也要有渲染兜底，不能直接把占位符甩给用户。
const mdSource = readFileSync("frontend/src/lib/md.tsx", "utf8");
const foundationCss = readFileSync("frontend/src/styles/foundation.css", "utf8");
assert(/function withEmoteTokens/.test(mdSource) && /\[表情\]/.test(mdSource),
  "消息渲染要把历史「[表情]」占位换成表情徽标");
assert(/\.md-emote/.test(foundationCss), "表情徽标要有样式，不能退化成普通文字");
// QQ 私聊是 1v1，气泡上不该再挂一行发言人昵称（「事上练（主人）」）；
// 那条 sender_name 只属于群聊，模型上下文里也一样。
const messageRowSource = readFileSync("frontend/src/features/chat/MessageRow.tsx", "utf8");
assert(/showSenderName && m\.sender_name/.test(messageRowSource),
  "发言人昵称要能按会话类型关掉，别无条件渲染");
assert(/showSenderName=\{isGroupChat\}/.test(chatSource), "聊天页只在群聊传 showSenderName");
assert(/conversations\.find\(\(conv\) => conv\.id === conversationId\)\?\.kind === "group"/.test(chatSource),
  "群聊判定要按当前会话，不是「该联系人有群就算群」");
// 一轮最多 3 张表情后，气泡要能折叠（微信「合并发图」的防刷屏做法），别把聊天撑成画廊。
assert(/imgsFolded/.test(messageRowSource) && /点开看全部/.test(messageRowSource),
  "3 张及以上图片要折叠成卡片并可展开");
assert(/\.msg-img-fold-btn/.test(componentsCss), "折叠/展开按钮要有样式");

// 设置助手自己的「对话设置」也要能存：回复方式 / 回放比例 / 历史占比上限就摆在那一屏上，
// 从前 formPayload 用一条 isAssistant 分支把整块 features 跳过，于是这三个开关点了既不出
// 脏值条也没有保存入口——用户看到的就是「没有保存按钮、改了不生效」。
const profileSource = readFileSync("frontend/src/features/profile/ProfileView.tsx", "utf8");
assert(
  /payload\.features = \{ splitReply: f\.splitReply, turnPct: f\.turnPct, tokenPct: f\.tokenPct \}/.test(profileSource),
  "助手模式必须回传它那一屏能改的三项 features（后端按 key 合并，人格三段仍不碰）",
);
assert(
  /const dirty = loaded && snapshot\(\) !== baseline;/.test(profileSource),
  "脏值判定必须继续以 snapshot 与基线比对为准（保存条只在有改动时出现）",
);

// ── 表情语义层（批次四~七）：一处数据、一处检索、一处界面 ──────────────
const emoteSearchSource = readFileSync("src/emote/emote-search.ts", "utf8");
const qqEmoteSource = readFileSync("src/emote/qq-emote.ts", "utf8");
const assetsTableSource = readFileSync("src/media/assets.ts", "utf8");
const namingSource = readFileSync("src/emote/emote-naming.ts", "utf8");
const emoteModalSource = readFileSync("frontend/src/components/EmoteSemanticsModal.tsx", "utf8");

// 1) 那张 65 条的手写同义词表必须死透：叫法属于数据，不属于源码。
assert(
  !/EMOTE_SYNONYMS/.test(qqEmoteSource),
  "源码里不该再有 EMOTE_SYNONYMS——素材库的中文叫法是每张图自己的数据，写死在源码里永远追不上用户导入的东西",
);
assert(/FACE_SYNONYMS/.test(qqEmoteSource), "内置 face 那一层保留一张小词表是对的（那 29 个词是固定的）");

// 2) 选图只有一个出处：qq-emote 只管进出登记，怎么选在 emote-search。
assert(!/function pickEmoteByKeyword/.test(qqEmoteSource), "选图逻辑不该留在 qq-emote.ts");
assert(/export function pickEmoteByKeyword/.test(emoteSearchSource), "选图在 emote-search.ts 一处");
assert(/export function searchEmotes/.test(emoteSearchSource), "检索与选图同源（工具与 keyword 快路走同一套打分）");

// 3) 文件夹名不许撑大命中面：只命中文件夹名的那一档必须被阈值挡在自动发之外。
assert(/WEIGHT\.pack/.test(emoteSearchSource) && /matchedOn === "pack"/.test(emoteSearchSource),
  "文件夹名要有独立权重，并且单独判「这只命中了文件夹」");
assert(/AUTO_PICK_MIN_SCORE/.test(emoteSearchSource), "自动发要有分数线，不能命中就甩");

// 4) 语义列只在 assets.ts 定义一次。
for (const column of ["emote_caption", "emote_alias", "emote_pack", "emote_named_at", "emote_use_count"]) {
  assert(new RegExp(column + "\\s+").test(assetsTableSource), "语义列 " + column + " 要在资产表里");
}
assert((assetsTableSource.match(/CREATE TABLE IF NOT EXISTS assets/g) ?? []).length === 1,
  "assets 表只能建一次");

// 5) 表情这一对工具同开同关：只开一个等于让她能查不能发、或能发只能猜。
assert(/off\.add\("send_emote"\); off\.add\("emote_search"\)/.test(toolsSource),
  "send_emote 与 emote_search 必须挂在同一个开关上");
assert(/name: "emote_search"/.test(toolsSource), "emote_search 要在工具表里");
assert(/emote_id/.test(toolsSource) && /getAssetById\(emoteId\)/.test(toolsSource),
  "按 id 发要服务端查库，不接受模型自己拼的地址");
assert(/每轮最多查一次|已经查过一次/.test(toolsSource), "一轮一次的约束要写进工具描述或返回体");

// 6) 认图作业只写语义三字段，且失败带人话原因。
assert(/applyEmoteNaming/.test(namingSource), "认图写回走同一条清洗入口");
assert(/retryable/.test(namingSource) && /RATE_LIMIT/.test(namingSource),
  "限流要单独判可重试——实测免费档第 7 张就 429，一律不重试等于半库判死");
assert(/needsStaticVariant\(asset\.url\)/.test(namingSource), "动图要采帧认，只看首帧会把动作描述成姿势");
assert(/referenceName/.test(namingSource) && /文件名是「/.test(namingSource), "文件命名要作为视觉识别的参考线索，不能只用于分类");

// 7) 界面只有一处管表情语义：认图 CTA、文件夹筛选、改名弹窗都在媒体库里，没有第二个入口。
assert(/runNaming/.test(mediaLibrarySource), "「智能识别」在媒体库这一页");
assert(/EmoteSemanticsModal/.test(mediaLibrarySource), "改名弹窗由媒体库唤起");
for (const file of [
  "frontend/src/features/settings/MediaSection.tsx",
  "frontend/src/features/profile/ProfileView.tsx",
  "frontend/src/features/profile/QQSection.tsx",
]) assert(!/EmoteSemanticsModal/.test(readFileSync(file, "utf8")), "语义卡不该在 " + file + " 里再开一份");
assert(/未命名/.test(mediaLibrarySource), "没认过名的卡要直说缺什么，而不是摊一个英文句柄给用户");
assert(/未命名/.test(mediaLibrarySource) && /智能识别/.test(mediaLibrarySource),
  "CTA 要把「为什么值得点一次」讲清楚（找不到，而不是「体验更好」）");
assert(!/onBlur=\{\(\) => (set|save)/.test(emoteModalSource), "弹窗里的字段要受控，不能靠失焦提交");
assert(!/重新识别/.test(emoteModalSource) && /智能识别/.test(emoteModalSource),
  "弹窗那颗按钮首次也叫「智能识别」——没有『先重新后首次』的两套名");
assert(/renaming \? \(queueLine \?\? "排队中"\)/.test(emoteModalSource) && /esem-spin/.test(experienceCss),
  "单张识别要有进行态（转圈+文案），不能只剩一个置灰按钮");
assert(/识别完成，写了名称/.test(emoteModalSource) && !/setEdit\(null\)/.test(mediaLibrarySource.split("renameOne")[1]?.slice(0, 700) ?? ""),
  "识别完弹窗不关：结果回填字段并行内说明");
assert(/esem-folder-select/.test(emoteModalSource) && /DEFAULT_FOLDER, \.\.\.folders/.test(emoteModalSource),
  "文件夹是下拉单选，「默认」排第一");
// 8) JSX 里用到的新类名必须在 CSS 里有定义——「类名写错」在页面上表现为挤成一团，最难自己发现。
const cssAll = componentsCss + "\n" + experienceCss;
for (const cls of ["ml-naming", "ml-naming-copy", "ml-naming-progress", "content-sub", "content-search-row", "row2", "esem", "esem-shot", "esem-fields", "esem-chips"]) {
  assert(new RegExp("\\." + cls + "[\\s,{:.]").test(cssAll), "样式类 ." + cls + " 必须在 CSS 里有定义");
}
assert(/\.content-badge\.unnamed/.test(componentsCss), "「没名字」角标要有自己的位置，别和别的角标叠在一起");
assert(/\.esem\s*\{[\s\S]{0,200}grid-template-columns:\s*minmax\([^)]*\)\s+minmax\(0,\s*1fr\)/.test(cssAll),
  "语义卡是图 + 字段两栏（右栏必须能收缩，否则字段被挤成一条缝）");
assert(/@media \(max-width: 560px\)[\s\S]*?\.esem \{ grid-template-columns: 1fr/.test(experienceCss),
  "窄屏收成单栏（面板宽度在这台机上不是固定值）");

// 9) 识别详情：机器做过的事必须能被查、能被改（逐张结果 / 只重试失败项 / 文件夹能开真目录 / 名字来源可见）。
assert(/识别详情/.test(mediaLibrarySource), "概览条上要有进入识别详情的入口");
assert(/ml-results/.test(mediaLibrarySource), "逐张识别结果要有列表");
assert(/retryFailed/.test(mediaLibrarySource) && /只重试失败的/.test(mediaLibrarySource), "失败的那几张要能单独重试，不能每次都从头再认一遍");
assert(/aria-expanded={showResults}/.test(mediaLibrarySource) && /识别进行中 ·/.test(mediaLibrarySource),
  "识别运行中也要能打开详情并看到实时进度");
assert(/识别刚开始，逐张结果会实时出现在这里/.test(mediaLibrarySource),
  "识别详情在还没有结果时也要给出明确状态，不能点了没反应");

assert(!/movePack|退回/.test(mediaLibrarySource),
  "「退回」整条链已退役：文件夹是真目录，整批调整走资源管理器");
assert(/rowOpenButtons|openFolderNamed/.test(mediaLibrarySource), "文件夹下拉每行都要有「在文件管理器中打开」");
assert(/openFolderNamed/.test(mediaLibrarySource) && /清除筛选/.test(mediaLibrarySource) && /scopeCounts/.test(mediaLibrarySource),
  "筛选计数跟随文件夹；条件叠加为空要报出具体条件并给「清除筛选」，不能谎称库是空的");
// 跑完之后启动文案必须消失：概览条已经写着上一轮结果，留着「已开始识别」会让人以为还在跑。
assert(/if \(!d\.job\.running\)[\s\S]{0,260}?setNotice\(handled > 0/.test(mediaLibrarySource),
  "轮询到作业结束时要用完成回执替换启动提示");
assert(/createPortal/.test(mediaLibrarySource) && /toast-layer/.test(mediaLibrarySource)
  && !/pf-comp-note/.test(mediaLibrarySource) && !/\{err !== ""/.test(mediaLibrarySource),
  "操作回执走轻提示浮层（自动消失、不占排版），不再是一条顶开布局的横 bar");
assert(/tone === "warn" \? 6000 : 4000/.test(mediaLibrarySource) && /toast\.tone === "warn" \? " warn"/.test(mediaLibrarySource),
  "失败与成功共用底部浮层：失败红色那一档、多停 2 秒；页面里不再内联红框");

// 12) 真目录布局：文件名是身份、目录是分类；表情包/<文件夹> 就是磁盘上的真目录。
const layoutSource = readFileSync("src/media/media-layout.ts", "utf8");
assert(/EMOTE_ROOT = "表情包"/.test(layoutSource) && /image: "图片"/.test(layoutSource),
  "目录词表（表情包/图片/视频/语音/文件）只在 media-layout.ts 定义一次");
assert(/rel_path/.test(assetsTableSource) && /missing/.test(assetsTableSource),
  "资产表要有落点列与失效列");
assert(/migrateMediaLayout\(\)/.test(readFileSync("src/index.ts", "utf8")),
  "启动要先跑布局迁移再对账（迁移排前，销账逻辑假设布局已定）");
assert(/renameRescue/.test(readFileSync("src/media/media.ts", "utf8")),
  "用户改名的文件要按哈希救回身份，不能标失效再登记成重复");
assert(/在文件管理器中打开/.test(mediaLibrarySource) && /openFolderNamed/.test(mediaLibrarySource),
  "文件夹下拉每行都有行内打开键，直接开对应的真目录");
assert(/a\.relPath/.test(mediaLibrarySource), "在文件管理器中显示走 rel_path 指到真身");
assert(/已失效/.test(mediaLibrarySource) && /content-badge\.broken/.test(componentsCss),
  "失效行要有角标，界面不能装作那张图还在");
assert(/job\?\.results \?\? \[\]/.test(mediaLibrarySource),
  "results 是可选字段，读不到要当空数组，不能把整页渲染崩掉");
assert(/content-name-src/.test(mediaLibrarySource), "每张卡要看得出名字是机器起的还是人写的");
assert(/emote_name_source/.test(assetsTableSource) && /namedBy/.test(assetsTableSource), "命名来源要有列，且写入点区分 auto/manual");
assert(/patch\.namedBy = "file"/.test(readFileSync("src/emote/qq-emote.ts", "utf8")), "导入文件名要写成 file，不能冒充手动维护或留下会从统计里消失的空值");
assert(/["any", "unnamed", "file", "auto", "manual"]/.test(readFileSync("src/server/routes/assets.ts", "utf8")), "列表接口必须接受 file 命名筛选，不能退回 any");
assert(/emoteNamedAt === 0/.test(assetsTableSource),
  "语义迁移只许作用在没识别过的行上——识别过的名字与标签是权威数据");
assert(!/moveEmoteWord|movePackWord/.test(readFileSync("src/server/routes/assets.ts", "utf8"))
  && !/moveEmoteWord/.test(assetsTableSource),
  "退回接口整条退役：没有 UI 入口的全库写口子不能留着当暗道");
for (const cls of ["ml-results", "ml-results-list", "ml-results-current", "ml-results-empty", "ml-toolbar", "ml-pack-pop", "ml-pack-row", "ml-naming-acts", "ml-naming-toggle", "ml-broken-chip", "ml-select-all", "ml-bulk"]) {
  assert(new RegExp("\\." + cls + "[\\s,{:.]").test(cssAll), "样式类 ." + cls + " 必须在 CSS 里有定义");
}
// 信息架构：表情包视角不许再摊三排 chips。类型行在这个视角是噪声（全是图片），
// 文件夹有几十个值必须收进下拉，而不是和命名状态混成一面墙。
assert(/view === "emote" \? \(/.test(mediaLibrarySource) && /\) : \(\s*<FilterMenu label="类型" value={kind}/.test(mediaLibrarySource),
  "类型筛选只在非表情包视角显示");
assert(/ml-pack-pop/.test(mediaLibrarySource) && /aria-haspopup="listbox"/.test(mediaLibrarySource),
  "文件夹筛选要收进一个带 listbox 语义的下拉控件");
assert(!/aria-label="文件夹">\s*\{packs\.map/.test(mediaLibrarySource),
  "文件夹不该再是一整排平铺的 chips");
assert(/全部文件夹/.test(mediaLibrarySource), "下拉的默认档叫「全部文件夹」");
assert(/\.ml-pack-pop\.up/.test(experienceCss) && /togglePack/.test(mediaLibrarySource), "文件夹下拉贴近视口底时要向上翻，不能整块落在折叠线外");
assert(/missing: missingOnly/.test(mediaLibrarySource) && /失效/.test(mediaLibrarySource), "失效项要有独立筛选，不能只能在概览条看到数字");
assert(/content-missing/.test(mediaLibrarySource) && /\.content-missing/.test(componentsCss), "失效卡片要渲染明确占位，不能只剩浏览器的破图图标");
assert(/文件命名/.test(mediaLibrarySource) && /scopeCounts\.file/.test(mediaLibrarySource), "导入文件名要有独立分类，不能显示成手动维护");
assert(/智能识别选中/.test(mediaLibrarySource) && /only: selectedIds, force: true/.test(mediaLibrarySource), "批量勾选后要能对选中项强制智能识别");
assert(/selectAllFiltered/.test(mediaLibrarySource) && /全选 \$\{totalInScope\}/.test(mediaLibrarySource), "全选要覆盖当前筛选的全部结果，不能只选已加载的 25 张");
assert(/content-pick/.test(mediaLibrarySource) && /\.content-pick/.test(componentsCss), "卡片上要有批量选择框");


// 导入只走原生选文件夹；入口收在表情包视角的工具行里（页头顶不再压一张「添加」大卡片）。
const mediaSectionSource2 = readFileSync("frontend/src/features/settings/MediaSection.tsx", "utf8");
assert(!/pickDirectory\(|onImportDir|onPickFile|自动收录聊天中收到的图片/.test(mediaSectionSource2),
  "MediaSection 只剩标题+媒体库：添加动作已并入表情包视角");
assert(/pickDirectory/.test(mediaLibrarySource) && /导入文件夹/.test(mediaLibrarySource) && /上传图片/.test(mediaLibrarySource),
  "上传/导入在 MediaLibrary 的表情包工具行里，选中即导入");
assert(!/本地文件夹路径/.test(mediaLibrarySource) && !/tagTouched/.test(mediaLibrarySource),
  "手敲路径与改名输入已退役——文件夹名只有源文件夹名一个来源");
assert(/folderNameOf/.test(readFileSync("src/emote/qq-emote.ts", "utf8")), "归属文件夹＝源文件夹名，前后端同口径");
assert(/canceled: true/.test(readFileSync("frontend/src/lib/native-dialog.ts", "utf8"))
  && /"error" in picked/.test(mediaLibrarySource),
  "取消文件夹选择器是正常操作：静默返回，不弹红条（真失败才有 error）");
assert(!/ml-pack-note|打开表情包目录/.test(mediaLibrarySource),
  "下拉不留解释性长文和底部大按钮——默认置顶＋行内打开键已经说明一切");
assert(/a\.pack === DEFAULT_EMOTE_FOLDER \? -1/.test(assetsTableSource),
  "文件夹清单「默认」恒排第一");
assert(/e\.dir === EMOTE_ROOT/.test(readFileSync("src/media/media.ts", "utf8")),
  "散放在 表情包/ 根下的图自动挪进 默认 文件夹并认领");

// 10) 文件夹层：单一归属是写出来的不变量，不是界面上的约定。
assert(/DEFAULT_EMOTE_FOLDER/.test(assetsTableSource) && /export function oneFolder/.test(assetsTableSource),
  "默认文件夹与归一函数只在 assets.ts 定义一次");
assert(/backfillEmoteFolder\(\);/.test(assetsTableSource), "启动时收敛存量的空归属/多归属");
assert(!/share\.get\(tag\)/.test(assetsTableSource),
  "词频猜文件夹的规则必须退役——真库上它把 47 个语义词啃进了不参与检索的 pack");
assert(/esem-folder-select/.test(emoteModalSource) && /pack: \[folder\]/.test(emoteModalSource),
  "弹窗里文件夹是下拉单选，保存时恒为单元素");
assert(/folders=\{packs\.map/.test(mediaLibrarySource), "弹窗的文件夹选项来自全库清单");
assert(/\.esem-folder/.test(experienceCss), "文件夹单选 chip 要有选中态样式");
assert(/export function setEmoteMark[\s\S]{0,700}?DEFAULT_EMOTE_FOLDER/.test(assetsTableSource),
  "聊天里随手标的图要有默认归属，不能散在「全部」里");

// 11) 文件管理器入口：单张表情定位原图、文件夹下拉打开媒体目录——只在桌面端出现。
assert(/mediaDir: mediaDir\(\)/.test(readFileSync("src/server/routes/assets.ts", "utf8")),
  "列表接口要带媒体目录绝对路径，桌面端才拼得出原图位置");
assert(/const DESKTOP = "__TAURI_INTERNALS__" in window/.test(mediaLibrarySource)
  && /revealInFolder/.test(mediaLibrarySource)
  && /DESKTOP && !a\.missing/.test(mediaLibrarySource),
  "「在文件管理器中显示」对所有类型的媒体卡片开放（失效行除外），浏览器端整条入口不出现");
assert(/清理此项/.test(mediaLibrarySource) && /"dropMissing"/.test(mediaLibrarySource)
  && /dropMissingAsset/.test(assetsTableSource),
  "失效行给「清理此项」：删死账的口子只对 missing=1 开，文件还在的删不动");
assert(/"probeMissing"/.test(mediaLibrarySource) && /markMissingIfGone/.test(assetsTableSource),
  "打开文件夹失败就地验真标失效——会话中删的文件不用等下一轮对账，清理按钮当场出现");

console.log("聊天与助手权限 UI 回归测试：全部通过");
