import { settingsApi } from "../api";
import type { CapabilityName, SettingsSnapshot } from "../types";

/**
 * 「模型配置」的一键导出 / 导入。
 *
 * 走的是**纯前端 + 现有写入接口**这条路：/api/settings 本来就把完整配置（含密钥）下发给
 * 本机界面，所以导出不需要新端点，导入也只是把文件里的内容按现有那几个写接口重放一遍。
 * 少一个能从公网打到的新入口，就少一类新风险（本应用挂在公网隧道上且明确不做鉴权）。
 *
 * 密钥的规矩：默认**剥掉**，文件名和文件里的 note 都写明剥了几处；带密钥要显式勾选。
 */

export const MODEL_CONFIG_KIND = "xiaomo-model-config";
export const MODEL_CONFIG_VERSION = 2;

/** 一份能力端点档里可以进文件的字段。 */
const CAP_KEYS = ["baseUrl", "apiKey", "name", "voice", "timeoutMs"] as const;

export type FileCapProfile = {
  label: string;
  baseUrl: string;
  name: string;
  timeoutMs?: number;
  voice?: string;
  /** 键不存在 = 导出时按用户选择剥掉了；空串 = 本机本来就没填。 */
  apiKey?: string;
};

export type FileProfile = {
  label: string;
  mode: string;
  baseUrl: string;
  name: string;
  timeoutMs: number;
  /** 键不存在 = 导出时按用户选择剥掉了；空串 = 本机本来就没填。 */
  apiKey?: string;
  extraBody: Record<string, unknown>;
  caps: Record<string, boolean>;
  thinkingLevel: string;
  thinkingLevels: string[];
  thinkingParam: string;
  thinkingMode: string;
  maxInputTokens: number;
  maxOutputTokens: number;
};

export type FileCapCard = {
  activeLabel: string;
  profiles: FileCapProfile[];
  /**
   * 这张卡的候选不自己存，就是「主模型接入」那批档里的一份（记忆提取）。
   * 所以文件里只记档名、不重复导出那批档；导入时按档名指回本机新档。
   */
  fromMain?: boolean;
};

export type ModelConfigFile = {
  kind: string;
  version: number;
  exportedAt: string;
  /** 文件里到底有没有密钥：导入侧靠它决定敢不敢往能力卡写接口地址 */
  hasKeys: boolean;
  /** 导出那一刻本机在用哪份档。只是说明，导入不会顺手改动正在生效的模型。 */
  activeLabel: string;
  profiles: FileProfile[];
  /** 每张能力卡存了几份端点档、在用哪一份（按档名记，跨机器才有意义） */
  capabilities: Record<string, FileCapCard>;
  note: string;
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/** 档 + 接口地址 + 模型名：判定"这台机器上已经有这一份"的三件套。 */
const triple = (label: string, baseUrl: string, name: string): string => `${label}\n${baseUrl}\n${name}`;

export function buildModelConfig(snap: SettingsSnapshot, withKeys: boolean): { file: ModelConfigFile; stripped: number } {
  const profiles = snap.profiles ?? [];
  const labelOf = (id: string | null | undefined): string =>
    profiles.find((p) => p.id === id)?.label ?? "";
  let stripped = 0;

  const outProfiles: FileProfile[] = profiles.map((p) => {
    const base: FileProfile = {
      label: p.label,
      mode: str(p.mode) || "openai",
      baseUrl: str(p.baseUrl),
      name: str(p.name),
      timeoutMs: num(p.timeoutMs, 90000),
      extraBody: (p.extraBody ?? {}) as Record<string, unknown>,
      caps: { ...(p.caps ?? {}) } as unknown as Record<string, boolean>,
      thinkingLevel: str(p.thinkingLevel),
      thinkingLevels: [...(p.thinkingLevels ?? [])],
      thinkingParam: str(p.thinkingParam) || "effort",
      thinkingMode: str(p.thinkingMode),
      maxInputTokens: num(p.maxInputTokens, 0),
      maxOutputTokens: num(p.maxOutputTokens, 0),
    };
    const key = str(p.apiKey);
    if (key === "") {
      base.apiKey = "";
    } else if (withKeys) {
      base.apiKey = key;
    } else {
      stripped += 1;
    }
    return base;
  });

  const caps: ModelConfigFile["capabilities"] = {};
  for (const [name, card] of Object.entries(snap.capabilities ?? {})) {
    const list = card?.profiles ?? [];
    if (card?.linkedToMain === true) {
      const picked = list.find((p) => p.active);
      if (picked) caps[name] = { activeLabel: picked.label, profiles: [], fromMain: true };
      continue;
    }
    const profiles: FileCapProfile[] = [];
    for (const p of list) {
      const entry: FileCapProfile = { label: p.label, baseUrl: str(p.baseUrl), name: str(p.name) };
      if (typeof p.timeoutMs === "number") entry.timeoutMs = p.timeoutMs;
      if (str(p.voice) !== "") entry.voice = str(p.voice);
      if (str(p.apiKey) !== "") {
        if (withKeys) entry.apiKey = str(p.apiKey);
        else stripped += 1;
      }
      profiles.push(entry);
    }
    if (profiles.length > 0) {
      caps[name] = { activeLabel: list.find((p) => p.active)?.label ?? "", profiles };
    }
  }

  return {
    file: {
      kind: MODEL_CONFIG_KIND,
      version: MODEL_CONFIG_VERSION,
      exportedAt: new Date().toISOString(),
      hasKeys: withKeys,
      activeLabel: labelOf(snap.activeProfileId),
      profiles: outProfiles,
      capabilities: caps,
      note: withKeys
        ? "本文件含 API 密钥：只放在自己机器上，别发到群里或云盘。"
        : `本文件已剥掉 ${stripped} 处 API 密钥；导入后请在「主模型接入」里逐个补密钥。`,
    },
    stripped,
  };
}

/** 打成文件内容（键序固定，方便 diff 两份导出）。 */
export function modelConfigText(file: ModelConfigFile): string {
  return JSON.stringify(file, null, 2) + "\n";
}

export function modelConfigFileName(file: ModelConfigFile, d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `xiaomo-模型配置-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
    + (file.hasKeys ? "-含密钥" : "") + ".json";
}

export function downloadModelConfig(file: ModelConfigFile): void {
  const blob = new Blob([modelConfigText(file)], { type: "application/json;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = modelConfigFileName(file);
  a.click();
  URL.revokeObjectURL(a.href);
}

/** 解析并校验一份导出文件。错误都写成人话，界面直接展示。 */
export function parseModelConfig(raw: string): ModelConfigFile {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("这不是一份 JSON——请选「设置 → 主模型接入 → 导出」存下来的那个 .json");
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error("文件内容不是一个配置对象");
  const o = data as Record<string, unknown>;
  if (o.kind !== MODEL_CONFIG_KIND) throw new Error("这不是小茉的模型配置文件（缺 kind 标记）");
  if (num(o.version, 0) > MODEL_CONFIG_VERSION) {
    throw new Error(`这份文件来自更新版的小茉（文件 v${num(o.version, 0)} > 本机 v${MODEL_CONFIG_VERSION}），请先升级再用它导入`);
  }
  if (!Array.isArray(o.profiles)) throw new Error("文件里没有 profiles 列表");

  const profiles: FileProfile[] = [];
  for (const item of o.profiles as unknown[]) {
    if (item === null || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    const label = str(p.label).trim().slice(0, 24);
    if (label === "") continue;
    const capsIn = (p.caps !== null && typeof p.caps === "object" ? p.caps : {}) as Record<string, unknown>;
    const caps: Record<string, boolean> = {};
    for (const k of ["tools", "vision", "thinking", "thinkingOnly", "customProtocol"]) caps[k] = capsIn[k] === true;
    profiles.push({
      label,
      mode: str(p.mode) || "openai",
      baseUrl: str(p.baseUrl).trim(),
      name: str(p.name).trim(),
      timeoutMs: num(p.timeoutMs, 90000),
      ...(typeof p.apiKey === "string" ? { apiKey: p.apiKey.trim() } : {}),
      extraBody: (p.extraBody !== null && typeof p.extraBody === "object" && !Array.isArray(p.extraBody)
        ? p.extraBody : {}) as Record<string, unknown>,
      caps,
      thinkingLevel: str(p.thinkingLevel),
      thinkingLevels: Array.isArray(p.thinkingLevels) ? p.thinkingLevels.filter((x): x is string => typeof x === "string") : [],
      thinkingParam: str(p.thinkingParam) || "effort",
      thinkingMode: str(p.thinkingMode),
      maxInputTokens: num(p.maxInputTokens, 0),
      maxOutputTokens: num(p.maxOutputTokens, 0),
    });
  }
  if (profiles.length === 0) throw new Error("文件里一份模型档都没有（要么被起名为空，要么格式不对）");

  const capsIn = (o.capabilities !== null && typeof o.capabilities === "object" && !Array.isArray(o.capabilities)
    ? o.capabilities : {}) as Record<string, unknown>;
  const capabilities: ModelConfigFile["capabilities"] = {};
  for (const [name, card] of Object.entries(capsIn)) {
    if (card === null || typeof card !== "object" || Array.isArray(card)) continue;
    const raw0 = card as Record<string, unknown>;
    const fromMain = raw0.fromMain === true;
    const list = Array.isArray(raw0.profiles) ? raw0.profiles : [];
    const profiles: FileCapProfile[] = [];
    for (const item of list) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
      const raw = item as Record<string, unknown>;
      const entry: FileCapProfile = { label: str(raw.label).trim(), baseUrl: str(raw.baseUrl).trim(), name: str(raw.name).trim() };
      if (entry.label === "" || entry.name === "") continue;
      for (const k of CAP_KEYS) {
        const v = raw[k];
        if (k === "apiKey") { if (typeof v === "string" && v.trim() !== "") entry.apiKey = v.trim(); continue; }
        if (k === "voice") { if (typeof v === "string" && v !== "") entry.voice = v; continue; }
        if (k === "timeoutMs") { if (typeof v === "number") entry.timeoutMs = v; continue; }
        if (typeof v === "string" && v !== "") (entry as Record<string, unknown>)[k] = v;
      }
      profiles.push(entry);
    }
    const activeLabel = str(raw0.activeLabel);
    if (fromMain) {
      if (activeLabel !== "") capabilities[name] = { activeLabel, profiles: [], fromMain: true };
    } else if (profiles.length > 0) {
      capabilities[name] = { activeLabel, profiles };
    }
  }

  return {
    kind: MODEL_CONFIG_KIND,
    version: MODEL_CONFIG_VERSION,
    exportedAt: str(o.exportedAt),
    hasKeys: o.hasKeys === true,
    activeLabel: str(o.activeLabel),
    profiles,
    capabilities,
    note: str(o.note),
  };
}

/** 导入前给界面看的账：新增几份、跳过几份重复、能力卡能不能写。 */
export type ImportPlan = {
  add: FileProfile[];
  dup: string[];
  /** 会写进哪几张能力卡（name → 要新增的端点档名；带 refLabel 的是"指向主模型那批档里的某一份"） */
  caps: Array<{ name: string; labels: string[]; refLabel?: string }>;
  /** 因为"文件没带密钥、写地址等于把本机密钥发到别处"而被挡下的能力卡 */
  capsBlocked: string[];
};

export function planImport(file: ModelConfigFile, snap: SettingsSnapshot): ImportPlan {
  const mine = new Set((snap.profiles ?? []).map((p) => triple(p.label, str(p.baseUrl), str(p.name))));
  const add = file.profiles.filter((p) => !mine.has(triple(p.label, p.baseUrl, p.name)));
  const dup = file.profiles.filter((p) => mine.has(triple(p.label, p.baseUrl, p.name))).map((p) => p.label);

  const caps: ImportPlan["caps"] = [];
  const capsBlocked: string[] = [];
  for (const [name, card] of Object.entries(file.capabilities)) {
    // 挂在主模型档上的那张卡不写任何地址密钥，只是把档名指过去，所以没有"发到别处"这回事。
    if (card.fromMain === true) { caps.push({ name, labels: [], refLabel: card.activeLabel }); continue; }
    const local = snap.capabilities?.[name as CapabilityName];
    const localBases = new Set((local?.profiles ?? []).map((p) => str(p.baseUrl)));
    // 没带密钥的档只允许落在"本机已经认识"的地址上：否则等于把本机密钥发去别人写的端点。
    const unsafe = card.profiles.some((p) => !file.hasKeys && p.apiKey === undefined && !localBases.has(p.baseUrl));
    if (unsafe) { capsBlocked.push(name); continue; }
    caps.push({ name, labels: card.profiles.map((p) => p.label) });
  }
  return { add, dup, caps, capsBlocked };
}

export type ImportResult = {
  added: number;
  skipped: number;
  failed: Array<{ label: string; error: string }>;
  caps: number;
  /** 几张挂主模型档的卡（记忆提取）按档名指成功了一份 */
  refs: number;
  capsBlocked: number;
};

/**
 * 按文件重放写入。一律**新增**（后端重新分配 id），绝不覆盖本机已有的同名档——
 * 导入错文件时最坏结果只是多几份没用的档，删掉即可，不会把正在用的那份改坏。
 */
export async function runImport(file: ModelConfigFile, snap: SettingsSnapshot): Promise<ImportResult> {
  const plan = planImport(file, snap);
  const out: ImportResult = {
    added: 0, skipped: plan.dup.length, failed: [], caps: 0, refs: 0, capsBlocked: plan.capsBlocked.length,
  };

  for (const p of plan.add) {
    const payload: Record<string, unknown> = {
      label: p.label, mode: p.mode, baseUrl: p.baseUrl, name: p.name, timeoutMs: p.timeoutMs,
      extraBody: p.extraBody, caps: p.caps, thinkingLevel: p.thinkingLevel, thinkingLevels: p.thinkingLevels,
      thinkingParam: p.thinkingParam, thinkingMode: p.thinkingMode,
      maxInputTokens: p.maxInputTokens, maxOutputTokens: p.maxOutputTokens,
    };
    if (typeof p.apiKey === "string") payload.apiKey = p.apiKey;
    try {
      await settingsApi.saveProfile(payload);
      out.added += 1;
    } catch (e: unknown) {
      out.failed.push({ label: p.label, error: e instanceof Error ? e.message : String(e) });
    }
  }

  for (const c of plan.caps) {
    const card = file.capabilities[c.name];
    if (!card) continue;
    for (const p of card.profiles) {
      try {
        await settingsApi.capabilityProfile({
          capability: c.name, op: "save", label: p.label, baseUrl: p.baseUrl, name: p.name,
          ...(p.apiKey !== undefined ? { apiKey: p.apiKey } : {}),
          ...(p.voice !== undefined ? { voice: p.voice } : {}),
          ...(p.timeoutMs !== undefined ? { timeoutMs: p.timeoutMs } : {}),
        });
        out.caps += 1;
      } catch (e: unknown) {
        out.failed.push({ label: `能力卡「${c.name}」的 ${p.label}`, error: e instanceof Error ? e.message : String(e) });
      }
    }
    // 文件里在用的那一份导进来就接着在用：换机器时"哪张卡跑什么"不该变。
    // 挂在主模型档上的那张卡，它的 profiles 就是那批档，所以按档名找 id 这一段两边通用。
    if (card.activeLabel !== "") {
      const snap2 = await settingsApi.fetchSettings().catch(() => null);
      const id = snap2?.capabilities?.[c.name]?.profiles.find((p) => p.label === card.activeLabel)?.id ?? "";
      if (id === "") continue;
      try {
        await settingsApi.capabilityProfile({ capability: c.name, op: "activate", id });
        if (c.refLabel !== undefined) out.refs += 1;
      } catch {
        // 指不过去就当没指：本机没有同名的主模型档，比猜一份更诚实，也不算失败项。
      }
    }
  }
  return out;
}
