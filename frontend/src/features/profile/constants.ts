import type { PersonaDraft } from "../../lib/persona-doc";

export type ProfileTab = "background" | "identity" | "relationship";

/**
 * 资料页三个分区：对应通用角色卡三件套（scenario / description / 关系设定文件）。
 *
 * 三段**合计**的字数上限见下面的 PERSONA_TOTAL_MAX——不按段均摊，一段可以占满全部额度。
 */
export const TABS: Array<{ key: ProfileTab; label: string; hint: string }> = [
  { key: "background", label: "背景", hint: "相遇场景、世界观、常见的相处情境" },
  { key: "identity", label: "人设", hint: "角色身份、性格、说话方式与行为约束" },
  { key: "relationship", label: "与用户关系", hint: "关系阶段、称呼、边界" },
];

/**
 * 三段人设的合计字数上限，须与后端 src/settings.ts 的 PERSONA_TOTAL_MAX 一致
 * （smoke 里有断言钉着这个等式，改一边不改另一边会立刻红）。
 *
 * 单段可以占到全部额度——写长人设的人常常只填「人设」一段。超预算时后端按
 * 背景 → 人设 → 关系 的顺序静默砍，所以界面先在保存前拦一道（见 ProfileView.save）。
 */
export const PERSONA_TOTAL_MAX = 30_000;

export type ProfileMode = "create" | "edit";

/** 资料页顶部分区：人格设定 / 对话设置 是编辑表单；记忆 / 主动性 / 内容库 是内嵌的运行视图面板。 */
export type ProfilePage = "persona" | "settings" | "memory" | "proactive" | "gallery";

export type Draft = PersonaDraft;

export const EMPTY_DRAFT: Draft = { name: "", background: "", identity: "", relationship: "" };
