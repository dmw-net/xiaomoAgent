import { useCallback, useEffect, useRef, useState } from "react";
import ContactChip from "../../components/ContactChip";
import { memoryApi } from "../../api";
import MemoryCard from "../memory/MemoryCard";
import type { RecallResult } from "../../types";
import type { PanelAria } from "../../components/Tabs";

/**
 * 记忆召回试验台：唯一跟着当前会话联系人走的分区，所以它单独按联系人重挂载
 * （换人清掉输入与结果），而状态页其余部分和所在 tab 都不该被换人打断。
 * 召回请求本身不带联系人参数——服务端认的是全站当前联系人。
 */
export default function RecallSection({ contactId, embedded = false, contactName, contactAvatar, onSwitchContact, onOpenContacts, panel }: {
  panel: PanelAria;
  contactId?: string;
  embedded?: boolean;
  contactName: string;
  contactAvatar: string;
  onSwitchContact: (id: string) => void;
  onOpenContacts: () => void;
}): JSX.Element {
  const [probeQ, setProbeQ] = useState("");
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<RecallResult | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 代次守卫：去抖后连发两请求时旧的可能后到，不拦就会用旧关键词的结果覆盖新的。 */
  const probeSeq = useRef(0);

  const runProbe = useCallback((q: string): void => {
    if (!q.trim()) { setProbe(null); return; }
    const seq = ++probeSeq.current;
    setProbing(true);
    void memoryApi
      .recall(q, 6, contactId)
      .then((d) => {
        if (seq !== probeSeq.current) return;
        // 后端正常一定带 events；但缺字段/旧 bundle/异常响应下不能崩，归一化成空数组。
        setProbe({ ...(d ?? {}), events: Array.isArray(d?.events) ? d.events : [] });
      })
      .catch((e: Error) => {
        if (seq === probeSeq.current) setProbe({ events: [], total: -1, keywords: [], err: e.message });
      })
      .finally(() => { if (seq === probeSeq.current) setProbing(false); });
  }, [contactId]);

  const onProbeInput = useCallback((v: string): void => {
    setProbeQ(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => runProbe(v), 350);
  }, [runProbe]);

  // 换联系人时组件重挂，这里的计时器随实例一起消失，不用手动清
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

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
              找到 <b>{events.length}</b> 条
            </div>
            {events.length === 0 && (
              <div className="hint">没找到：可能还没记过，或换个说法再试。</div>
            )}
            {events.map((e) => (
              <MemoryCard key={e.id} event={e} />
            ))}
          </div>
        )}
        {probe?.err && <div className="result" id="probeResult"><div className="hint">查询失败：{probe.err}</div></div>}
      </div>
    </div>
  );
}
