import { useCallback, useEffect, useState } from "react";
import { memoryApi } from "../../api";
import MemoryPanel from "./MemoryPanel";
import RecallSection from "../status/RecallSection";
import type { MemorySpaceInventory, MemorySpaceSelection } from "../../types";

/**
 * 联系人资料页「记忆」这一栏的工作区：记忆检查 + 记忆清单共用同一个空间选择。
 *
 * 空间状态必须在这一层，因为「输入一句话，看联系人能想起什么」和下面的清单得是同一口径——
 * 分成两套选择器，用户就会用清单确认了空间、再用检查框问出跨空间的结果。
 */
export default function MemoryWorkspace({ active, contactId, who }: {
  active: boolean;
  contactId: string;
  who: string;
}): JSX.Element {
  const [space, setSpace] = useState<MemorySpaceSelection>({ kind: "all" });
  const [inventory, setInventory] = useState<MemorySpaceInventory | null>(null);

  const loadSpaces = useCallback((): void => {
    // 盘点的失败不拦清单：下拉只是不出现，记忆照样能看。
    void memoryApi.fetchMemorySpaces(contactId)
      .then((d) => setInventory(d ?? null))
      .catch(() => setInventory(null));
  }, [contactId]);

  useEffect(() => { setSpace({ kind: "all" }); setInventory(null); loadSpaces(); }, [contactId, loadSpaces]);
  // 切走再切回这一栏：聊天可能刚长出新的群/成员，空间下拉的数得跟着重新盘。
  useEffect(() => { if (active) loadSpaces(); }, [active, loadSpaces]);

  return (
    <div className="pf-memory-stack">
      <RecallSection embedded contactId={contactId} contactName={who} contactAvatar=""
        onSwitchContact={() => undefined} onOpenContacts={() => undefined} panel={{}}
        space={space} spaceInventory={inventory} />
      <MemoryPanel panel={{}} active={active} contactId={contactId} who={who}
        space={space} onSpaceChange={setSpace} spaceInventory={inventory} onSpacesChanged={loadSpaces} />
    </div>
  );
}
