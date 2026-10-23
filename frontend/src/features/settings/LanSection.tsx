// 手机与远程访问：局域网（手机/平板）与内网穿透（固定端口 + 隧道域名）。
//
// 为什么三件事放在一张卡里：它们其实是同一条链路的不同环节。
//   ① 局域网开关 —— 手机连同一个 Wi-Fi 就能打开；
//   ② 固定端口   —— 桌面端默认用系统随机端口（躲开被占），隧道程序没法指向一个会变的端口；
//   ③ 隧道域名   —— 隧道进来的 Host 是公网域名，不在白名单里会被 Host 守卫 403。
// 三者共用同一个**访问码**：服务端免码的唯一情形是「本机发起 + 访问本机地址」，
// 所以局域网手机与隧道访客都要先输码。这不是可选项——/api/settings 会把模型密钥原文回给调用方，
// 「可达」绝不能等于「可读」。
import { useEffect, useState } from "react";
import { lanApi, type LanState } from "../../api";
import { copyText } from "../../lib/clipboard";
import { relaunchApp } from "../../lib/native-dialog";

export function LanSection() {
  const [state, setState] = useState<LanState | null>(null);
  const [qr, setQr] = useState("");
  const [qrFailed, setQrFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  /** 打开局域网前先给一次明确的知情确认。 */
  const [asking, setAsking] = useState(false);
  const [portInput, setPortInput] = useState("");
  const [portNote, setPortNote] = useState("");
  const [hostInput, setHostInput] = useState("");
  const [hostNote, setHostNote] = useState("");
  /** 访问码自定义：编辑态与输入值分开，取消时不丢已保存的码。 */
  const [editingCode, setEditingCode] = useState(false);
  const [codeInput, setCodeInput] = useState("");
  const [codeNote, setCodeNote] = useState("");
  const [codeBad, setCodeBad] = useState(false);

  const load = async (): Promise<LanState | null> => {
    try {
      const next = await lanApi.fetchLan();
      setState(next);
      return next;
    } catch {
      setNote("读不到状态");
      return null;
    }
  };

  useEffect(() => { void load(); }, []);

  // 输入框跟着已保存的值走（只在第一次拉到状态时填，别打断用户正在输入的内容）
  useEffect(() => {
    if (state === null) return;
    setPortInput(state.portSetting === 0 ? "" : String(state.portSetting));
    setHostInput(state.tunnelHosts.join(", "));
  }, [state?.portSetting, state?.tunnelHosts.join(",")]);

  // 二维码按需生成：qrcode 不该进首屏 chunk（与微信/QQ 那两处同一取舍）。
  useEffect(() => {
    const url = state?.enabled === true ? state.urls[0] ?? "" : "";
    if (url === "") { setQr(""); setQrFailed(false); return; }
    // 访问码放 fragment 里：不会发给服务端，也不会出现在 Referer 里；
    // 手机打开登录页后由页面自己读出来预填，少让用户手输一长串数字。
    const code = state?.code.replace(/[^0-9]/g, "") ?? "";
    const scanUrl = code === "" ? url : `${url}/#code=${code}`;
    let alive = true;
    void (async () => {
      try {
        const { toDataURL } = await import("qrcode");
        const dataUrl = await toDataURL(scanUrl, { margin: 1, width: 200 });
        if (alive) { setQr(dataUrl); setQrFailed(false); }
      } catch {
        if (alive) { setQr(""); setQrFailed(true); }
      }
    })();
    return () => { alive = false; };
  }, [state?.enabled, state?.urls, state?.code]);

  /**
   * 局域网开关要动监听 socket，服务端是「先回响应、再换绑」，
   * 所以点完要再拉几次状态，等 bound 真的翻过来（或超时报错）才说话。
   */
  const apply = async (enabled: boolean): Promise<void> => {
    setBusy(true);
    setNote("");
    setAsking(false);
    try {
      await lanApi.setLan(enabled);
      for (let i = 0; i < 8; i += 1) {
        const next = await load();
        if (next !== null && next.bound === enabled && next.bindError === "") {
          setNote(enabled ? "已打开。" : "已关闭。");
          setBusy(false);
          return;
        }
        if (next !== null && next.bindError !== "") {
          setNote(`打开失败：${next.bindError}`);
          setBusy(false);
          return;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      setNote("还没生效，稍后刷新看看");
    } catch (e) {
      setNote(e instanceof Error ? e.message : "操作失败，请重试。");
    }
    setBusy(false);
  };

  const applyPort = async (): Promise<void> => {
    setBusy(true);
    setPortNote("");
    const raw = portInput.trim();
    const value = raw === "" ? 0 : Number(raw);
    try {
      const next = await lanApi.setLanPort(value);
      setState(next);
      setPortNote(next.portNext === 0
        ? `已设为自动分配（当前 ${next.port}），重启后生效。`
        : `已保存，重启后监听 ${next.portNext}。`);
    } catch (e) {
      setPortNote(e instanceof Error ? e.message : "改端口失败");
    }
    setBusy(false);
  };

  const saveHosts = async (): Promise<void> => {
    setBusy(true);
    setHostNote("");
    const hosts = hostInput.split(/[,\s]+/).map((h) => h.trim()).filter((h) => h !== "");
    try {
      const next = await lanApi.saveTunnelHosts(hosts);
      setState(next);
      setHostNote(hosts.length === 0 ? "已清空。" : "已保存。");
    } catch (e) {
      setHostNote(e instanceof Error ? e.message : "保存失败");
    }
    setBusy(false);
  };

  const rotate = async (): Promise<void> => {
    setBusy(true);
    setCodeNote("");
    try {
      setState(await lanApi.rotateLanCode());
      setEditingCode(false);
      setCodeBad(false);
      setCodeNote("已换新码，已连设备需要重新输入。");
    } catch {
      setCodeBad(true);
      setCodeNote("换码失败，请重试。");
    }
    setBusy(false);
  };

  const openCodeEditor = (): void => {
    setCodeNote("");
    setCodeBad(false);
    if (editingCode) {
      setEditingCode(false);
      return;
    }
    setCodeInput((state?.code ?? "").replace(/[^0-9]/g, ""));
    setEditingCode(true);
  };

  const saveCode = async (): Promise<void> => {
    const digits = codeInput.replace(/[^0-9]/g, "");
    if (digits.length < 6 || digits.length > 12) {
      setCodeBad(true);
      setCodeNote("访问码用 6–12 位数字。");
      return;
    }
    setBusy(true);
    setCodeNote("");
    setCodeBad(false);
    try {
      const next = await lanApi.setLanCode(digits);
      setState(next);
      setEditingCode(false);
      setCodeNote("已保存。已连上的设备需要用新码重新进入。");
    } catch (e) {
      setCodeBad(true);
      setCodeNote(e instanceof Error ? e.message : "保存失败");
    }
    setBusy(false);
  };

  const copy = async (text: string): Promise<void> => {
    const result = await copyText(text);
    setNote(result === "ok" ? "已复制" : "复制失败，请手动选中");
  };

  const restart = async (): Promise<void> => {
    const r = await relaunchApp();
    if (!r.ok) setPortNote(`没能自动重启：${r.error ?? ""}，请手动重开。`);
  };

  const enabled = state?.enabled === true;
  const urls = state?.urls ?? [];
  const hosts = state?.tunnelHosts ?? [];
  const portPending = state !== null && state.portNext !== 0 && state.portNext !== state.port;
  const autoPending = state !== null && state.portSetting === 0 && state.port !== 0 && state.portNext === 0;

  return (
    <div className="card card-pad lan-card" style={{ marginTop: 12 }}>
      <div className="lan-head">
        <div>
          <div className="subhead">手机与远程访问</div>
          <div className="hint">
            默认只有这台电脑能访问。同一 Wi-Fi 下打开开关即可；想在别处用，得自己配内网穿透。
          </div>
        </div>
        {state !== null && (
          <span className={`lan-state${enabled ? " on" : ""}`}>
            {enabled ? "局域网已开启" : "仅本机"}
          </span>
        )}
      </div>

      {state === null ? (
        <div className="hint" style={{ marginTop: 8 }}>读取中…</div>
      ) : (
        <>
          <div className="lan-block">
            <div className="lan-row">
              <div className="lan-row-main">
                <label>允许局域网访问</label>
                <div className="hint">同一 Wi-Fi 下的手机 / 平板可以打开下面的地址。</div>
              </div>
              <div className="preset-row lan-toggle" role="group" aria-label="允许手机访问">
                <button type="button" className="preset" aria-pressed={!enabled} disabled={busy} onClick={() => void apply(false)}>关闭</button>
                <button type="button" className="preset" aria-pressed={enabled} disabled={busy} onClick={() => (enabled ? void apply(true) : setAsking(true))}>开启</button>
              </div>
            </div>

            {asking && (
              <div className="lan-confirm">
                打开后同一网络的设备都能访问（含聊天记录与模型密钥）。只在可信网络下开启。
                <div className="actions" style={{ marginTop: 8 }}>
                  <button type="button" className="btn sm" onClick={() => setAsking(false)}>取消</button>
                  <button type="button" className="primary sm" disabled={busy} onClick={() => void apply(true)}>确认开启</button>
                </div>
              </div>
            )}
          </div>

          {enabled && (
            <div className="lan-block">
              <div className="lan-block-title">手机打开的地址</div>
              {urls.length === 0 ? (
                <div className="hint">没找到可用的网卡地址（检查是否连着 Wi-Fi / 网线）。</div>
              ) : (
                <div className="lan-access">
                  <div className="lan-urls">
                    {urls.map((url) => (
                      <div key={url} className="lan-url">
                        <code>{url}</code>
                        <button type="button" className="btn sm" onClick={() => void copy(url)}>复制</button>
                      </div>
                    ))}
                    <div className="hint">Windows 弹防火墙提示时选「允许访问」。</div>
                  </div>
                  <div className="lan-qr">
                    {qr !== "" ? (
                      <img src={qr} alt="手机访问地址二维码" width={168} height={168} />
                    ) : (
                      <div className="hint">{qrFailed ? "二维码生成失败，直接复制上面的地址。" : "二维码生成中…"}</div>
                    )}
                    {qr !== "" && (
                      <div className="hint">
                        扫码后会自动填好访问码，点「进入」即可。二维码等同于访问码，别截图外传。
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="lan-block">
            <div className="lan-block-title">访问码</div>
            <div className="hint">
              手机 / 隧道首次访问要输它。登录页勾选「记住」后，下次打开会自动进入；换码后已连设备需重输。
              {state.code === "" && "开启局域网或填写隧道域名后才需要它。"}
            </div>
            <div className="lan-code-row">
              <code className={`lan-code${state.code === "" ? " empty" : ""}`}>
                {state.code === "" ? "尚未生成" : state.code}
              </code>
              {state.code !== "" && (
                <button type="button" className="btn sm" onClick={() => void copy(state.code)}>复制</button>
              )}
              <button type="button" className="btn sm" disabled={busy} onClick={openCodeEditor}>
                {editingCode ? "取消" : "自定义"}
              </button>
              {state.code !== "" && (
                <button type="button" className="btn sm" disabled={busy} onClick={() => void rotate()}>随机换一个</button>
              )}
            </div>

            {editingCode && (
              <div className="lan-code-editor">
                <input
                  value={codeInput}
                  onChange={(e) => setCodeInput(e.target.value.replace(/[^0-9]/g, "").slice(0, 12))}
                  placeholder="输入 6–12 位数字"
                  inputMode="numeric"
                  aria-label="自定义访问码"
                />
                <button type="button" className="primary sm" disabled={busy} onClick={() => void saveCode()}>保存</button>
                <button type="button" className="btn sm" disabled={busy} onClick={() => setEditingCode(false)}>取消</button>
              </div>
            )}
            {codeNote !== "" && (
              <div className={`lan-note${codeBad ? " bad" : ""}`} role={codeBad ? "alert" : "status"}>{codeNote}</div>
            )}
          </div>

          <div className="lan-block">
            <div className="lan-block-title">远程访问（自己的内网穿透）</div>
            <div className="hint">
              小茉不做穿透，只配合你做两件事：固定端口、放行你的隧道域名。
            </div>
            <div className="lan-remote-grid" style={{ marginTop: 12 }}>
              <div className="field">
                <label>固定端口</label>
                <div className="hint">
                  桌面版默认随机端口（当前 <code>{state.port}</code>，每次启动都变）。内网穿透需要固定它；留空 = 自动。
                </div>
                <div className="lan-inline" style={{ marginTop: 8 }}>
                  <input
                    value={portInput}
                    onChange={(e) => setPortInput(e.target.value.replace(/[^0-9]/g, ""))}
                    placeholder="例如 8787（留空 = 自动）"
                    inputMode="numeric"
                  />
                  <button type="button" className="btn sm" disabled={busy} onClick={() => void applyPort()}>应用</button>
                  {portPending && (
                    <button type="button" className="primary sm" onClick={() => void restart()}>重启应用生效</button>
                  )}
                </div>
                {portPending && (
                  <div className="lan-note">
                    重启后监听 <code>{state.portNext}</code>（当前 {state.port}）。
                  </div>
                )}
                {autoPending && <div className="lan-note">已设为自动分配，重启后生效。</div>}
                {portNote !== "" && <div className="lan-note">{portNote}</div>}
              </div>

              <div className="field">
                <label>隧道域名</label>
                <div className="hint">
                  隧道指向这台电脑后，把它给的公网域名填在这里，否则请求会被 403 挡掉；多个用逗号或空格分开，留空 = 不信任外部域名。
                </div>
                <div className="lan-inline" style={{ marginTop: 8 }}>
                  <input
                    value={hostInput}
                    onChange={(e) => setHostInput(e.target.value)}
                    placeholder="例如 xiaomo.example.com"
                  />
                  <button type="button" className="btn sm" disabled={busy} onClick={() => void saveHosts()}>保存</button>
                </div>
                {hosts.length > 0 && (
                  <div className="lan-note">
                    隧道指向 <code>http://127.0.0.1:{state.portNext === 0 ? state.port : state.portNext}</code>。
                  </div>
                )}
                {hostNote !== "" && <div className="lan-note">{hostNote}</div>}
              </div>
            </div>
          </div>

          {state.bindError !== "" && (
            <div className="lan-note bad" role="alert">上次打开失败：{state.bindError}</div>
          )}
          {note !== "" && <div className="lan-note" role="status">{note}</div>}
        </>
      )}
    </div>
  );
}
