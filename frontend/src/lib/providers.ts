/**
 * 供应商这一层的唯一实现（显示规则与后端 settings.ts 的 providerLabel 同一条）。
 *
 * 后端不存供应商实体——同一批档里接口地址相同的就是同一家。所以"这家叫什么"要么
 * 是用户起过的名字（快照里的 providerNames），要么退回这家第一个模型的档名，再退回主机名。
 *
 * 主模型接入与五张能力卡都从这里取归组与取名：同一套数据在两个页面上长成两种样子，
 * 是这类"派生层"最容易出的错。
 */

/** 归组只需要这三样：主模型档与能力端点档都满足。 */
export type Endpoint = { id: string; label: string; baseUrl?: string; apiKey?: string; name?: string };

export type ProviderGroup<T extends Endpoint> = {
  baseUrl: string;
  /** 这家显示成什么：起过的名字 > 这家第一份档的名字 > ""（由 providerTitle 兜底）。 */
  label: string;
  /** 这个名字是供应商表里真起过的，还是档名顶上的——只有前者允许改名。 */
  named: boolean;
  models: T[];
  hasKey: boolean;
};

export const normBase = (v: string | null | undefined): string => (v ?? "").trim().replace(/\/+$/, "");

export function groupByProvider<T extends Endpoint>(
  items: T[],
  names: Record<string, string>,
): ProviderGroup<T>[] {
  const groups: ProviderGroup<T>[] = [];
  for (const p of items) {
    const base = normBase(p.baseUrl);
    let g = groups.find((x) => x.baseUrl === base);
    if (!g) {
      g = { baseUrl: base, label: names[base] ?? p.label ?? "", named: base in names, models: [], hasKey: false };
      groups.push(g);
    }
    g.models.push(p);
    if ((p.apiKey ?? "") !== "") g.hasKey = true;
  }
  return groups;
}

/** 一组（或一个地址）的显示名。 */
export function providerTitle<T extends Endpoint>(
  group: ProviderGroup<T> | null,
  names: Record<string, string> = {},
): string {
  if (!group) return "";
  return names[group.baseUrl] || group.label
    || group.baseUrl.replace(/^https?:\/\//, "").split("/")[0] || "未填地址";
}

export function providerLabel(
  baseUrl: string | null | undefined,
  names: Record<string, string>,
  profiles: Endpoint[],
): string {
  const base = normBase(baseUrl);
  const named = names[base];
  if (named) return named;
  const first = profiles.find((p) => normBase(p.baseUrl) === base);
  return first?.label || base.replace(/^https?:\/\//, "").split("/")[0] || base || "未填地址";
}

/**
 * 一份档在"挑模型"的地方该怎么写：`供应商 · 模型名`。
 * 只用档名不行——一家挂几个模型之后，两把同名的档（或一把叫"agnes 备用"的档）
 * 在联系人绑定、用量归属这些列表里根本分不开。
 */
export function profileTitle(
  p: Endpoint,
  names: Record<string, string>,
  profiles: Endpoint[],
): string {
  const prov = providerLabel(p.baseUrl, names, profiles);
  const model = p.name || p.label || "未填模型名";
  return prov === model ? prov : `${prov} · ${model}`;
}

/**
 * 挑模型的下拉选项：先按供应商排，同一家再按模型名排。
 * 不排的话一家挂几个模型就散成一屏（截图里「肖恩」的两份档中间夹了别家，找一份档要扫全 list）。
 * 取名和排序都收在这里：联系人绑定与记忆提取两处不该各写一份。
 */
export function profilePicks<T extends Endpoint>(
  items: T[],
  names: Record<string, string>,
): Array<{ value: string; label: string }> {
  const zh = "zh-Hans-CN";
  const prov = (p: T): string => providerLabel(p.baseUrl, names, items);
  return [...items]
    .sort((a, b) => prov(a).localeCompare(prov(b), zh)
      || (a.name || a.label).localeCompare(b.name || b.label, zh))
    .map((p) => ({ value: p.id, label: profileTitle(p, names, items) }));
}
