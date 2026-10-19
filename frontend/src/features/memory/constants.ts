/** 记忆类型元数据：顺序即展示顺序。 */
export const KIND_META: Record<string, { label: string }> = {
  promise: { label: "承诺" },
  preference: { label: "偏好" },
  fact: { label: "事实" },
  plan: { label: "计划" },
  mood: { label: "情绪" },
};

export const KIND_ORDER = ["promise", "preference", "fact", "plan", "mood"];

export function kindLabel(kind: string): string {
  return KIND_META[kind]?.label ?? kind;
}
