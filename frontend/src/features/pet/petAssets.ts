// 桌宠形象资产清单：一类动作一组候选，运行时按状态随机抽播。
// 「大肥鱼」的动画与立绘来自 dsh-pet 项目（署名与授权见 src/assets/pet/dafayu/CREDITS.md）。
// 之后做自制形象（小茉）时沿用同一份结构：再注册一个 skin 即可，窗口逻辑不用动。

// 素材走构建管线（src/assets + ?url）：拿到带内容哈希的同源 URL，由后端 /assets/* 通道发出。
// 不要把桌宠素材放回 frontend/public——后端对 dist 根文件是逐条白名单（pages.ts 的
// ROOT_IMAGE_ASSETS），public 里的新目录后端不会发，界面上只会拿到 404。
import beishubiaoTuozhuaiUrl from "../../assets/pet/dafayu/beishubiao-tuozhuai-xuankong-fankui.webm?url";
import ceshenJizaoPaoUrl from "../../assets/pet/dafayu/ceshen-jizao-pao.webm?url";
import chifantuanUrl from "../../assets/pet/dafayu/chifantuan.webm?url";
import baifanBowlEmptyUrl from "../../assets/pet/dafayu/baifan/bowl-empty.png?url";
import baifanBowlFullUrl from "../../assets/pet/dafayu/baifan/bowl-full.png?url";
import baifanRiceBallUrl from "../../assets/pet/dafayu/baifan/rice-ball.png?url";
import chibaifanUrl from "../../assets/pet/dafayu/chibaifan.webm?url";
import chifanWanfanUrl from "../../assets/pet/dafayu/chifan-wanfan.webm?url";
import chiTokenUrl from "../../assets/pet/dafayu/chi-token.webm?url";
import chiwancanUrl from "../../assets/pet/dafayu/chiwancan.webm?url";
import chiwucanUrl from "../../assets/pet/dafayu/chiwucan.webm?url";
import chizaocanUrl from "../../assets/pet/dafayu/chizaocan.webm?url";
import daijiHuxiXiuxianUrl from "../../assets/pet/dafayu/daiji-huxi-xiuxian.webm?url";
import kaixinXiaopaoUrl from "../../assets/pet/dafayu/kaixin-xiaopao.webm?url";
import qidaiKaifanUrl from "../../assets/pet/dafayu/qidai-kaifan.webm?url";
import dianjiHaixiuUrl from "../../assets/pet/dafayu/dianji-huiying-haixiu-jingya.webm?url";
import dianjiKaixinUrl from "../../assets/pet/dafayu/dianji-huiying-kaixin-yuedong.webm?url";
import dianjiYuanqiUrl from "../../assets/pet/dafayu/dianji-huiying-yuanqi-huishou.webm?url";
import dongzhangxiwangUrl from "../../assets/pet/dafayu/dongzhangxiwang.webm?url";
import gongzhuangtaiMangluUrl from "../../assets/pet/dafayu/gongzhuangtai-manglu-dianan.webm?url";
import pangxieZouluUrl from "../../assets/pet/dafayu/pangxie-zoulu.webm?url";
import shuijiaoKaishiUrl from "../../assets/pet/dafayu/shuijiao-kaishi.webm?url";
import shuijiaoQilaiUrl from "../../assets/pet/dafayu/shuijiao-qilai.webm?url";
import shuijiaoXunhuanUrl from "../../assets/pet/dafayu/shuijiao-xunhuan.webm?url";
import suisuinianFadaiUrl from "../../assets/pet/dafayu/suisuinian-fadai-suisuinian.webm?url";
import toutouChilingshiUrl from "../../assets/pet/dafayu/toutou-chilingshi.webm?url";
import xieDaimaUrl from "../../assets/pet/dafayu/xie-daima.webm?url";
import yaoshanNaliangUrl from "../../assets/pet/dafayu/yaoshan-naliang.webm?url";
import youxianHenggaUrl from "../../assets/pet/dafayu/youxian-hengga.webm?url";
import youyaNvpuwuUrl from "../../assets/pet/dafayu/youya-nvpuwu.webm?url";
import yuandiMofangUrl from "../../assets/pet/dafayu/yuandi-zhuanxin-wan-mofang.webm?url";
import yuandiPiaofuUrl from "../../assets/pet/dafayu/yuandi-piaofu-tabu.webm?url";
import dafayuPortraitUrl from "../../assets/pet/dafayu/main-character.png?url";

// ── 窗口贴合几何（实测数据，换素材要重测）────────────────
// 角色包围盒由 scratch/dsh-ref/measure.mjs 扫描透明像素得出（640×360 画幅坐标）。
// 2026-11-14 全解码重测（媒体响应不再被压缩后）：全体动作并集 (196,59)-(432,332)，
// 完全落在下面 CHAR_BOX 推导出的裁剪框 (192,10)-(446,336) 内——拖拽段与「悠闲哼歌」
// 早先测到的越界/失败帧是媒体被压缩时的加载残帧假象，不是素材真的越界。
const CHAR_BOX = { x0: 208, y0: 63, x1: 430, y1: 332 };
const PAD_X = 3; // 抗锯齿边缘余量
const CROP_TOP_PAD = 2;
const CROP_BOTTOM_PAD = 4;
/** 窗口在角色包围盒外再加的可抓握边（角色宽的 6%）：没抓准也能抓住角色本体，
 *  减少点击穿透把拖拽漏给桌面、变成图标框选的误触。 */
const GRAB_PAD = Math.round((CHAR_BOX.x1 - CHAR_BOX.x0) * 0.06);
const HEADROOM_FRAC = 0.2; // 头顶气泡区 = 窗口宽的 20%
const CROP_X0 = CHAR_BOX.x0 - PAD_X - GRAB_PAD;
const CROP_X1 = CHAR_BOX.x1 + PAD_X + GRAB_PAD;
const CROP_W = CROP_X1 - CROP_X0;
const CROP_Y0 = CHAR_BOX.y0 - CROP_TOP_PAD - Math.round(HEADROOM_FRAC * CROP_W);
const CROP_Y1 = CHAR_BOX.y1 + CROP_BOTTOM_PAD;

/** 窗口高宽比：桌宠窗口高 = 体型 × 该值。
 *  窗口按角色包围盒裁剪，不等于视频全画幅——画幅里角色只占约 1/3 宽，
 *  整幅 16:9 播放会让窗口四周挂一大圈透明区，挡鼠标又不贴合（dsh-pet 的紧贴观感）。 */
export const PET_HEIGHT_RATIO = +((CROP_Y1 - CROP_Y0) / CROP_W).toFixed(4);

/** 视频在窗口内的定位（相对体型的倍数）：把裁剪区铺满窗口，画幅其余部分平移到窗口外。
 *  数值由实测包围盒推导，换素材必须重测（scratch/dsh-ref/measure.mjs）。 */
export const PET_VIDEO_STYLE = {
  w: +(640 / CROP_W).toFixed(4),
  left: +(-CROP_X0 / CROP_W).toFixed(4),
  top: +(-CROP_Y0 / CROP_W).toFixed(4),
};

/** 角色头顶在窗口内的纵向位置（相对体型）：气泡贴它上沿，点击穿透以此为界。 */
export const PET_CHAR_TOP = +((CHAR_BOX.y0 - CROP_Y0) / CROP_W).toFixed(4);

/** 气泡底边（相对体型）。 */
export const PET_BUBBLE_BOTTOM = +(PET_HEIGHT_RATIO - PET_CHAR_TOP - 0.02).toFixed(4);

/** 动作名 → 菜单显示名（动作点播子菜单用）：素材键是拼音串，直接摆出来没法读。 */
export const PET_ANIM_LABELS: Readonly<Record<string, string>> = {
  "daiji-huxi-xiuxian": "待机呼吸-休息",
  "dongzhangxiwang": "东张西望",
  "pangxie-zoulu": "螃蟹走路",
  "yuandi-piaofu-tabu": "原地漂浮-踏步",
  "xie-daima": "写代码",
  "gongzhuangtai-manglu-dianan": "忙碌点按",
  "shuijiao-kaishi": "睡觉-入睡",
  "shuijiao-xunhuan": "睡觉-安睡",
  "shuijiao-qilai": "睡觉-醒来",
  "dianji-huiying-kaixin-yuedong": "开心跃动",
  "dianji-huiying-yuanqi-huishou": "元气挥手",
  "dianji-huiying-haixiu-jingya": "害羞·惊讶",
  "beishubiao-tuozhuai-xuankong-fankui": "被拖拽-悬空",
  "suisuinian-fadai-suisuinian": "发呆碎碎念",
  "chibaifan": "吃白饭",
  "kaixin-xiaopao": "开心小跑",
  "ceshen-jizao-pao": "侧身急躁跑",
  "qidai-kaifan": "期待开饭",
  "chifantuan": "吃饭团",
  "chifan-wanfan": "吃饭·碗饭",
  "chizaocan": "吃早餐",
  "chiwucan": "吃午餐",
  "chiwancan": "吃晚餐",
  "chi-token": "吃Token",
  "toutou-chilingshi": "偷吃零食被抓住",
  "yaoshan-naliang": "摇扇纳凉",
  "youya-nvpuwu": "优雅女仆舞",
  "yuandi-zhuanxin-wan-mofang": "专心玩魔方",
  "youxian-hengga": "悠闲哼歌",
};

/** 动作显示名：清单里没有的键回退原名（新素材没登记也不至于摆拼音串给用户猜）。 */
export function animLabel(name: string): string {
  return PET_ANIM_LABELS[name] ?? name;
}

export type PetSkinAssets = {
  /** 形象显示名。 */
  label: string;
  /** 立绘 URL（设置页预览）。 */
  portraitUrl: string;
  /** 语义名 → 透明动画 URL；键就是动作池里写的名字。 */
  videos: Readonly<Record<string, string>>;
  /** 待机池：一直接着播，尽量不连播同一部。 */
  idle: readonly string[];
  /** 移动池：窗口滑行时循环播。 */
  walk: readonly string[];
  /** 睡觉三段：入睡 → 循环 → 醒来。 */
  sleepStart: string;
  sleepLoop: string;
  sleepEnd: string;
  /** 工作池 / 玩耍池：随机动作触发，播完回待机。 */
  work: readonly string[];
  play: readonly string[];
  /** 吃饭池：动作点播「吃饭」分类（吃Token 另入工作池，生成时随机吃）。 */
  eat: readonly string[];
  /** 吃白饭玩法的五段动画名（槽位契约：跑到底/追饭/期待/吃碗饭/吃饭团）。 */
  baifan: readonly [string, string, string, string, string];
  /** 点击回应池：点一下随机播一部。 */
  click: readonly string[];
  /** 被拖拽悬空：拖住时循环播。 */
  drag: readonly string[];
    /** 碎碎念说话动作池。 */
    whisper: readonly string[];

};

const DAFAYU_VIDEOS: Readonly<Record<string, string>> = {
  "daiji-huxi-xiuxian": daijiHuxiXiuxianUrl,
  "dongzhangxiwang": dongzhangxiwangUrl,
  "youxian-hengga": youxianHenggaUrl,
  "pangxie-zoulu": pangxieZouluUrl,
  "yuandi-piaofu-tabu": yuandiPiaofuUrl,
  "xie-daima": xieDaimaUrl,
  "gongzhuangtai-manglu-dianan": gongzhuangtaiMangluUrl,
  "yuandi-zhuanxin-wan-mofang": yuandiMofangUrl,
  "yaoshan-naliang": yaoshanNaliangUrl,
  "youya-nvpuwu": youyaNvpuwuUrl,
  "shuijiao-kaishi": shuijiaoKaishiUrl,
  "shuijiao-xunhuan": shuijiaoXunhuanUrl,
  "shuijiao-qilai": shuijiaoQilaiUrl,
  "dianji-huiying-kaixin-yuedong": dianjiKaixinUrl,
  "dianji-huiying-yuanqi-huishou": dianjiYuanqiUrl,
  "dianji-huiying-haixiu-jingya": dianjiHaixiuUrl,
  "beishubiao-tuozhuai-xuankong-fankui": beishubiaoTuozhuaiUrl,
  "suisuinian-fadai-suisuinian": suisuinianFadaiUrl,
  "chibaifan": chibaifanUrl,
  "kaixin-xiaopao": kaixinXiaopaoUrl,
  "ceshen-jizao-pao": ceshenJizaoPaoUrl,
  "qidai-kaifan": qidaiKaifanUrl,
  "chifantuan": chifantuanUrl,
  "chifan-wanfan": chifanWanfanUrl,
  "chizaocan": chizaocanUrl,
  "chiwucan": chiwucanUrl,
  "chiwancan": chiwancanUrl,
  "chi-token": chiTokenUrl,
  "toutou-chilingshi": toutouChilingshiUrl,
};

/** 「吃白饭」玩法的道具图（碗/饭团，非动画）。 */
export const PET_BAIFAN_PIC = {
  bowlFull: baifanBowlFullUrl,
  bowlEmpty: baifanBowlEmptyUrl,
  riceBall: baifanRiceBallUrl,
} as const;

export const PET_SKINS = {
  dafayu: {
    label: "大肥鱼",
    portraitUrl: dafayuPortraitUrl,
    videos: DAFAYU_VIDEOS,
    // 「悠闲哼歌」放碎碎念池：哼歌配气泡说话比待机更搭（重测包围盒在裁剪框内，
    // 早先「飘出画幅」的记录是媒体加载失败时的坏帧假象）。
    idle: ["daiji-huxi-xiuxian", "dongzhangxiwang"],
    walk: ["pangxie-zoulu", "yuandi-piaofu-tabu"],
    sleepStart: "shuijiao-kaishi",
    sleepLoop: "shuijiao-xunhuan",
    sleepEnd: "shuijiao-qilai",
    work: ["xie-daima", "gongzhuangtai-manglu-dianan", "chi-token"],
    play: ["yuandi-zhuanxin-wan-mofang", "yaoshan-naliang", "youya-nvpuwu"],
    eat: ["chibaifan", "chifan-wanfan", "chizaocan", "chiwucan", "chiwancan", "toutou-chilingshi"],
    /** 吃白饭玩法的五段动画名（槽位契约同原版 config.jsonc：跑到底/追饭/期待/吃碗饭/吃饭团）。 */
    baifan: ["kaixin-xiaopao", "ceshen-jizao-pao", "qidai-kaifan", "chifan-wanfan", "chifantuan"],
    click: ["dianji-huiying-kaixin-yuedong", "dianji-huiying-yuanqi-huishou", "dianji-huiying-haixiu-jingya"],
    drag: ["beishubiao-tuozhuai-xuankong-fankui"],
    whisper: ["suisuinian-fadai-suisuinian", "youxian-hengga"],
  },
} as const satisfies Record<string, PetSkinAssets>;

export type PetSkinId = keyof typeof PET_SKINS;

/** 单形象阶段固定用「大肥鱼」；自制形象做完后再挂设置项切换。 */
export const PET_DEFAULT_SKIN: PetSkinId = "dafayu";

export function skinOf(id: PetSkinId): PetSkinAssets {
  return PET_SKINS[id];
}

export function animUrl(skin: PetSkinAssets, name: string): string {
  return skin.videos[name] ?? "";
}

/** 池里随机抽一个；给了 avoid 就尽量不连播同一部。 */
export function pick(pool: readonly string[], avoid?: string): string {
  if (pool.length <= 1) return pool[0] ?? "";
  const rest = avoid === undefined ? pool : pool.filter((n) => n !== avoid);
  return rest[Math.floor(Math.random() * rest.length)] ?? pool[0] ?? "";
}
