import type { CapabilityName } from "../../types";

/**
 * 首次设置的步骤判定。纯函数、无 DOM：界面用它，冒烟也直接 import 它——
 * 判定只有一份，不会出现"测试里跳过了、界面上还卡着"。
 *
 * 形态是「步骤由状态推导」而不是线性向导：补齐哪项就跳到哪项。
 * 步骤本身按小茉的真实缺口排：接完模型先问要不要配眼睛耳朵，再问要不要改人设。
 */
export type OnboardingStep = "owner" | "model" | "capability" | "persona" | "ready";

export const STEPS: Array<{ id: OnboardingStep; label: string; hint: string }> = [
  { id: "owner", label: "怎么称呼你", hint: "填了联系人说话才知道叫你什么" },
  { id: "model", label: "接入模型", hint: "没接模型时只会回一句演示回复" },
  { id: "capability", label: "眼睛和耳朵", hint: "用不上可以整步跳过" },
  { id: "persona", label: "改改人设", hint: "不改就用默认那份，随时能在资料页改" },
  { id: "ready", label: "开始相处", hint: "发第一条消息" },
];

/** 记忆提取不算"额外配过能力"：它不填就跟随主力，接完模型它就自己就绪了。 */
export const OPTIONAL_CAPABILITIES: CapabilityName[] = [
  "imageVision", "imageGeneration", "speechToText", "textToSpeech",
];

export type OnboardingInput = {
  /** 用户自己的称呼（设置 → 我的资料）。空 = 还没填。 */
  ownerName: string;
  modelReady: boolean;
  capabilitiesReady?: Partial<Record<CapabilityName, boolean>>;
  /** 人设还是出厂那份 = 没动过，值得问一句要不要改。省略按"改过了"处理（老快照不催这一步）。 */
  personaIsDefault?: boolean;
};

export function capsConfigured(input: OnboardingInput): boolean {
  return OPTIONAL_CAPABILITIES.some((name) => input.capabilitiesReady?.[name] === true);
}

/** 当前该做哪一步。能力与人设两步都是"可跳过的未完成"，所以它们挡不住 ready 之外的跳转。 */
export function resolveStep(input: OnboardingInput): OnboardingStep {
  if (input.ownerName.trim() === "") return "owner";
  if (!input.modelReady) return "model";
  if (!capsConfigured(input)) return "capability";
  if (input.personaIsDefault === true) return "persona";
  return "ready";
}

export function stepIndex(step: OnboardingStep): number {
  return STEPS.findIndex((s) => s.id === step);
}
