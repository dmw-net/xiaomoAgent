import { useCallback, useEffect, useRef, useState } from "react";
import ContactChip from "../../components/ContactChip";
import { memoryApi } from "../../api";
import MemoryCard from "../memory/MemoryCard";
import { spaceKey } from "../memory/MemorySpaceSelect";
import type { MemorySpaceInventory, MemorySpaceSelection, RecallResult } from "../../types";
import type { PanelAria } from "../../components/Tabs";

/**
 * 记忆召回试验台：唯一跟着当前会话联系人走的分区，所以它单独按联系人重挂载
 * （换人清掉输入与结果），而状态页其余部分和所在 tab 都不该被换人打断。
 * 召回请求本身不带联系人参数——服务端认的是全站当前联系人。
 *
 * 带 space 时只在那个空间能被想起的记忆里查。真实会话就是按空间召回的，
 * 不带空间等于把别的群、别的成员也算进来，这个框就不再是"联系人能想起什么"的答案。
 */
export default function RecallSection({ contactId, embedded = false, contactName, contactAvatar, onSwitchContact, onOpenContacts, panel, space, spaceInventory }: {
  panel: PanelAria;
  contactId?: string;
  embedded?: boolean;
  contactName: string;
  contactAvatar: string;
  onSwitchContact: (id: string) => void;
  onOpenContacts: () => void;
  space?: MemorySpaceSelection;
  spaceInventory?: MemorySpaceInventory | null;
}): JSX.Element {
  const [probeQ, setProbeQ] = useState("");
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<RecallResult | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 代次守卫：去抖后连发两请求时旧的可能后到，不拦就会用旧关键词的结果覆盖新的。 */
  const probeSeq = useRef(0);
  const spaceNames: Record<string, string> = spaceInventory === null || spaceInventory === undefined ? {} : Object.fromEntries([
    [spaceInventory.private.conversationId, spaceInventory.private.title || "私聊"],
    ...spaceInventory.groups.map((g) => [g.conversationId, g.title]),
  ]);
  const spaceLabel = space === undefined || space.kind === "all" ? ""
    : space.kind === "global" ? "全局"
    : spaceNames[space.conversationId] ?? "这段对话";

  const runProbe = useCallback((q: string): void => {
    if (!q.trim()) { setProbe(null); return; }
    const seq = ++probeSeq.current;
    setProbing(true);
    void memoryApi
      .recall(q, 6, contactId, space)
      .then((d) => {
        if (seq !== probeSeq.current) return;
        // 后端正常一定带 events；但缺字段/旧 bundle/异常响应下不能崩，归一化成空数组。
        setProbe({ ...(d ?? {}), events: Array.isArray(d?.events) ? d.events : [] });
      })
      .catch((e: Error) => {
        if (seq === probeSeq.current) setProbe({ events: [], total: -1, keywords: [], err: e.message });
      })
      .finally(() => { if (seq === probeSeq.current) setProbing(false); });
  }, [contactId, space]);

  const onProbeInput = useCallback((v: string): void => {
    setProbeQ(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => runProbe(v), 350);
  }, [runProbe]);

  // 换联系人时组件重挂，这里的计时器随实例一起消失，不用手动清
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // 切空间时把已有的一句话重新问一遍：结果标的是「只在某个空间能被想起」，
  // 空间换了却不重跑，屏幕上留的就是上一个空间的答案。
  const spaceSignature = space === undefined ? "" : spaceKey(space);
  useEffect(() => { if (probeQ.trim() !== "") runProbe(probeQ); }, [spaceSignature]); // eslint-disable-line react-hooks/exhaustive-deps

  // 渲染兜底：events 必须是数组（数据入口已归一化，这里再保险一次，防任何路径漏网）。
  const events = Array.isArray(probe?.events) ? probe.events : [];

  return (
    <div className={embedded ? "card card-pad pf-set-card pf-memory-probe" : "section"} {...panel}>
      {embedded ? (
        <>
          <div className="pf-set-title">记忆检查</div>
          <div className="pf-set-sub">输入一句话，看看{contactName || "联系人"}现在能从中想起哪些长期记忆。这里只做观察，不会改写记忆。</div>
        </>
      ) : (
        <div className="form-row" style={{ alignItems: "center", gap: 10, marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>看看联系人能想起什么</h2>
          <span className="hint">当前会话联系人：</span>
          <ContactChip name={contactName} avatar={contactAvatar} onPick={onSwitchContact} onManageContacts={onOpenContacts} />
        </div>
      )}
      <div className="probe">
        <div className="field">
          <input
            id="probeInput"
            aria-label="要查询的记忆关键词"
            placeholder="输入一句话，看联系人能从中想起什么…"
            value={probeQ}
            onChange={(e) => onProbeInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") runProbe(probeQ); }}
          />
          <button type="button" id="probeBtn" disabled={probing} onClick={() => runProbe(probeQ)}>测试</button>
        </div>
        {probe && !probe.err && (
          <div className="result" id="probeResult">
            <div className="sum">
              找到 <b>{events.length}</b> 条{spaceLabel !== "" ? <span className="hint"> · 只在「{spaceLabel}」能被想起的记忆里查</span> : null}
            </div>
            {events.length === 0 && (
              <div className="hint">没找到：可能还没记过，或换个说法再试{spaceLabel !== "" ? "；切回「全部空间」再看看是不是记在别处了" : ""}。</div>
            )}
            {events.map((e) => (
              <MemoryCard key={e.id} event={e} spaceNames={spaceNames} />
            ))}
          </div>
        )}
        {probe?.err && <div className="result" id="probeResult"><div className="hint">查询失败：{probe.err}</div></div>}
      </div>
    </div>
  );
}
