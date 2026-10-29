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
 * 3. 设置助手权限只能有输入区 chip 一个入口；高风险二次确认、常显红态与
 *    本轮权限快照都不能被子系统改动悄悄绕过。
 * 4. 报错 toast 不能永久挂在屏幕上，但也要给足阅读和点重试的时间。
 * 5. 设置助手里的上下文浮层必须压在弹窗之上，否则点击后看似没有反应。
 */
import { readFileSync } from "node:fs";
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
const settingsSource = readFileSync("frontend/src/features/settings/SettingsView.tsx", "utf8");
const agentSource = readFileSync("src/agent.ts", "utf8");
const toolsSource = readFileSync("src/tools.ts", "utf8");
const assistantSource = readFileSync("src/assistant.ts", "utf8");
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
const mediaSource = readFileSync("src/media.ts", "utf8");
const mediaDialogSource = readFileSync("frontend/src/components/MediaMaintenanceDialog.tsx", "utf8");
const contentLibrarySource = readFileSync("frontend/src/features/profile/ContentLibraryPanel.tsx", "utf8");
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
assert(/content-kind-filters/.test(contentLibrarySource) && /kindCounts/.test(contentLibrarySource), "联系人内容库必须同时支持来源与媒体类型筛选");
assert(/<video className="content-video"/.test(contentLibrarySource), "联系人内容库里的视频应可直接预览");
assert(/<VoiceMessageBubble compact/.test(contentLibrarySource), "联系人内容库里的语音应可直接播放，而不是显示成普通文件");
assert(/transcript=\{a\.transcript\}/.test(contentLibrarySource), "联系人内容库里的语音应保留可展开的转写");

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
assert(/const TIERS[\s\S]*?"readonly"[\s\S]*?"confirm"[\s\S]*?"auto"/.test(assistantPermissionSource), "权限 chip 应保留只读/变更前确认/完全自主三档");
assert(/对所有设置助手会话生效/.test(assistantPermissionSource), "权限说明必须写明全局生效");
assert(/next === "auto"[\s\S]*?setConfirmAuto\(true\)/.test(assistantPermissionSource), "进入完全自主前必须二次确认");
assert(/权限变更从下一条消息开始生效/.test(assistantPermissionSource), "UI 必须说明权限从下一条消息生效");
assert(/\.asst-perm-chip\.is-auto[\s\S]*?var\(--danger\)/.test(componentsCss), "完全自主 chip 必须常显危险色");
assert(/assistantPermissionSnapshot/.test(agentSource) && /toolDefsForApi\(contactId, permissionSnapshot\)/.test(agentSource), "当前轮必须使用启动时的权限快照声明工具");
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

console.log("聊天与助手权限 UI 回归测试：全部通过");
