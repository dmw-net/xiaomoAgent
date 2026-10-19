/**
 * 软键盘/视口高度变化的唯一观察者。
 *
 * 两件事，各管一条浏览器路径：
 * ① `--kb`：iOS Safari 不认 viewport meta 里的 `interactive-widget=resizes-content`，
 *    只有视觉视口缩，布局高度得由这里补，否则输入条压在最后一条消息上。
 * ② 通知会话页重新贴底：Chrome/Android 认那个 meta，布局视口**自己**就缩了
 *    （此时 innerHeight 与 visualViewport.height 相等 → kb 恒为 0，①完全不介入），
 *    但 `#log` 的 scrollTop 不会跟着变 —— 实测可用高度 780→480 后距底从 0 变成 294，
 *    最后一条正好被输入条盖住。所以"要不要重新落底"必须看**可用高度变没变**，
 *    只看 kb>0 就会把 Chrome 这条主路径整个漏掉（用户手机实测就是这里没顶上去）。
 */
export function watchKeyboard(): void {
  const vv = window.visualViewport;
  let lastAvail = -1;
  const sync = (): void => {
    const h = vv ? vv.height : window.innerHeight;
    const kb = vv ? Math.max(0, Math.round(window.innerHeight - h - vv.offsetTop)) : 0;
    document.documentElement.style.setProperty("--kb", kb + "px");
    const avail = Math.round(h);
    // 首次只记基线：挂载那一下不该冒出一个"重新落底"事件
    if (lastAvail < 0) { lastAvail = avail; return; }
    if (avail === lastAvail) return;
    lastAvail = avail;
    // 复用「藏→显」那条通道：会话页自己按 stickRef 决定要不要落底，
    // 正在上翻看历史的人不会被拽回底部（微信就是这个口径）。
    window.dispatchEvent(new Event("xiaomo:chat-shown"));
  };
  if (vv) {
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
  }
  window.addEventListener("resize", sync);
  sync();
}
