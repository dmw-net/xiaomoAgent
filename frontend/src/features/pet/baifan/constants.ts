/**
 * 「吃白饭」小游戏的常量：节奏参数与台词池。
 * 数值与台词照搬原版（dsh-pet，MIT，baifan/constants.ts）——手感是玩法的一部分。
 * 玩法用的五段动画由 petAssets 的 skin.baifan 槽位给出（契约：跑到底/追饭/期待/吃碗饭/吃饭团）。
 * @module 桌宠吃白饭
 */

/** 地面线距视口底部的高度（米饭落在这里，桌宠脚踩在这条线上）。 */
export const GROUND_OFFSET = 26;

/** 跑向底部：蓄力时长（descend 片段先播一段）。 */
export const PREP_MS = 2100;
/** 跑向底部的滑行时长。 */
export const TRAVEL_MS = 5000;
/** 追饭跑动速度（px/s）。 */
export const RUN_SPEED = 290;
/** 没饭巡逻时的速度折减。 */
export const PATROL_SPEED_RATIO = 0.72;
/** 掉饭间隔（ms）。 */
export const SPAWN_MS = 4200;
/** 碗饭出现的概率（其余是饭团）。 */
export const BOWL_RATIO = 0.38;
/** 场上最多同时几份饭。 */
export const MAX_RICE = 2;
/** 离饭多近算「够得着」（px，按基准宽标定）。 */
export const EAT_PX = 40;
/** 多近算「到位」（px）。 */
export const ARRIVE_PX = 12;
/** 单段追饭位移上限（ms）。 */
export const TRIP_MAX_MS = 4500;
/** 追饭动画看门狗间隔（ms）。 */
export const SIDE_WATCH_MS = 400;
/** 没发位移时的歇拍（ms）。 */
export const IDLE_MS = 140;
/** 转身惩罚：身后的饭要乘这个系数才算距离（换向要重开跑步动画）。 */
export const BACK_TURN_PENALTY = 1.8;
/** 吃饭气泡时长（ms）。 */
export const BUBBLE_MS = 2400;
/** 嘴的高度占比（相对宠物盒高）。 */
export const MOUTH_RATIO = 0.63;
/** 嘴的水平偏移（相对宠物宽，朝向修正由调用方乘方向）。 */
export const MOUTH_DX = -0.03;
/** 基准宽（米饭尺寸按精灵宽 / 它 缩放）。 */
export const REF_WIDTH = 498;
/** 吃满几份吹一次牛。 */
export const FULL_EVERY = 5;

/** 台词池：只在合适的节拍上说一句，其余时间闭嘴，否则气泡会糊在演出上。 */
export const LINES = {
  start: ["开饭了——", "白饭时间到！", "饿了饿了饿了"],
  down: ["等我下去……", "下面有饭香", "让一让，我下去了"],
  expect: ["饭呢？饭呢？", "快点快点", "……还没好吗"],
  drop: ["掉下来了！", "接住！", "来了来了"],
  bowl: ["碗饭最香", "这个碗我要了", "再来一碗"],
  ball: ["饭团饭团", "一口一个", "捏得刚好"],
  full: ["嗝——还能吃！", "这点不够塞牙缝", "再来十份"],
} as const;
