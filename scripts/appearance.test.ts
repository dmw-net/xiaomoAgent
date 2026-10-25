/**
 * 外观偏好迁移的回归测试。
 *
 * 运行：node scripts/appearance.test.ts
 *
 * 为什么要单独测这段：旧主题皮肤已经被删除，迁移必须做到“保留用户色感、
 * 清掉旧键、已有强调色不被覆盖、重复执行幂等”。这四点任何一条出错，
 * 老用户升级后会看到错误颜色或残留皮肤属性。
 */

type Store = Map<string, string>;

function installBrowserDoubles(store: Store): { removedAttrs: string[] } {
  const removedAttrs: string[] = [];
  const localStorage = {
    getItem: (key: string): string | null => store.get(key) ?? null,
    setItem: (key: string, value: string): void => { store.set(key, value); },
    removeItem: (key: string): void => { store.delete(key); },
  };
  const document = {
    documentElement: {
      removeAttribute: (name: string): void => { removedAttrs.push(name); },
    },
  };
  Object.assign(globalThis, { localStorage, document, window: { dispatchEvent: (): void => {} } });
  return { removedAttrs };
}

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
  else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

const store: Store = new Map([["xiaomo.themeStyle", "paper"]]);
const { removedAttrs } = installBrowserDoubles(store);
const prefs = await import("../frontend/src/lib/ui-prefs.ts");

console.log("\n[外观偏好迁移]");
prefs.migrateAppearancePrefs();
check("旧主题风格键被清理", !store.has("xiaomo.themeStyle"));
check("和纸迁移为湖蓝强调色", store.get("xiaomo.accent") === "#2f6fed", store.get("xiaomo.accent"));
check("旧主题属性被移除", removedAttrs.includes("data-theme-style"), removedAttrs.join(","));
check("强调色预设包含品牌默认与五种个性色", prefs.ACCENT_PRESETS.length === 6, String(prefs.ACCENT_PRESETS.length));
check("默认预设回到品牌赤陶", prefs.ACCENT_PRESETS[0]?.hex === "", JSON.stringify(prefs.ACCENT_PRESETS[0]));

store.set("xiaomo.themeStyle", "classic");
store.set("xiaomo.accent", "#2f6fed");
prefs.migrateAppearancePrefs();
check("已有强调色不被旧主题覆盖", store.get("xiaomo.accent") === "#2f6fed", store.get("xiaomo.accent"));
check("旧键仍被清理", !store.has("xiaomo.themeStyle"));

store.set("xiaomo.themeStyle", "night");
store.delete("xiaomo.accent");
prefs.migrateAppearancePrefs();
check("夜航迁移为琥珀", store.get("xiaomo.accent") === "#d9821c", store.get("xiaomo.accent"));
prefs.migrateAppearancePrefs();
check("迁移可重复执行且幂等", store.get("xiaomo.accent") === "#d9821c" && !store.has("xiaomo.themeStyle"));
store.set("xiaomo.accent", "#2F6FED");
check("大小写不同的强调色被归一化", prefs.getAccent() === "#2f6fed", prefs.getAccent());

if (failures > 0) {
  console.error(`\n外观偏好迁移：${failures} 项失败`);
  process.exit(1);
}
console.log("\n外观偏好迁移：全部通过");