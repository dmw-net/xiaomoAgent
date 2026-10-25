// 确认卡片：confirm 档下助手发起不可逆操作（删扩展 / 开 JS 许可 / 导入扩展）时，
// 后端把它们挂成待确认动作，这里轮询并浮出来等用户真实点击。
//
// 为什么是卡片而不是让助手在文本里问：模型可以自己把 confirmed 参数传成 true，
// 「用户答了一句好」不构成证据；这里的同意/拒绝是后端确认凭证的唯一注入口，
// 模型无法伪造（详见 src/assistant.ts 的 guardDangerous）。

import { useCallback, useEffect, useRef, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { assistantApi, type AssistantPendingAction } from "../../api";

const POLL_MS = 4000;

export default function PendingCard({ contactId, active }: {
  /** 助手线程 id（assistant 或 assistant:<id>）。 */
  contactId: string;
  /** 弹窗没打开时不轮询。 */
  active: boolean;
}): JSX.Element | null {
  const [pending, setPending] = useState<AssistantPendingAction[]>([]);
  const [busy, setBusy] = useState("");
  const timer = useRef<number | null>(null);

  const load = useCallback((): void => {
    assistantApi.fetchPending(contactId)
      .then((r) => setPending(r.pending))
      .catch(() => setPending([])); // 轮询失败安静降级：卡片不见了≠动作没了，后端 10 分钟过期兜底
  }, [contactId]);

  useEffect(() => {
    if (!active) return;
    load();
    timer.current = window.setInterval(load, POLL_MS);
    return () => { if (timer.current !== null) window.clearInterval(timer.current); };
  }, [active, load]);

  const decide = (action: AssistantPendingAction, approved: boolean): void => {
    setBusy(action.id);
    const call = approved ? assistantApi.confirmPending(action.id) : assistantApi.declinePending(action.id);
    call.then(() => {
      setPending((prev) => prev.filter((p) => p.id !== action.id));
      // 后端会合成续跑消息开新一轮；下个轮询周期消息自然到位，这里无需再刷新会话。
    })
      .catch(() => { /* 404 = 已过期/已处理：下一轮轮询会把卡片收走 */ })
      .finally(() => setBusy(""));
  };

  if (pending.length === 0) return null;

  return (
    <div className="asst-pending" role="alertdialog" aria-label="操作确认">
      {pending.map((action) => (
        <div className="asst-pending-item" key={action.id}>
          <div className="asst-pending-head">
            <ShieldAlert size={15} aria-hidden />
            <b>{action.title}</b>
          </div>
          <div className="asst-pending-detail">{action.detail}</div>
          <div className="asst-pending-actions">
            <button type="button" className="primary sm" disabled={busy !== ""}
              onClick={() => decide(action, true)}>同意执行</button>
            <button type="button" className="sm" disabled={busy !== ""}
              onClick={() => decide(action, false)}>拒绝</button>
          </div>
        </div>
      ))}
    </div>
  );
}
