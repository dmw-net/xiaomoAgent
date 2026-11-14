/**
 * 「吃白饭」演出的宠物控制面：游戏只通过这组回调驱动桌宠，
 * PetView 负责把它接到自己的动画/位置/气泡与窗口形态上。
 * @module 桌宠吃白饭控制面
 */

/** PetView 注入的宠物控制面。 */
export interface PetGameControl {
  /** 点播一段动画（loop = 循环播）。 */
  playAnim(name: string, loop: boolean): void;
  /** 登记「当前片段播完」的一次性回调：游戏激活时 onAnimEnded 改派发给它。 */
  onClipEnd(cb: () => void): void;
  /** 滑行到视口坐标 (x, y)，ms 内到，resolve 于到位。 */
  moveTo(x: number, y: number, ms: number): Promise<void>;
  /** 桌宠盒左上角当前坐标（与米饭层同一视口坐标系）。 */
  pos(): { x: number; y: number };
  /** 游乐场尺寸（内嵌 = 主窗视口，独立窗口 = 扩窗后的窗内视口）。 */
  viewport(): { w: number; h: number };
  /** 气泡说一句。 */
  say(text: string, ms?: number): void;
  /** 体型宽（米饭/分数按它缩放）。 */
  petSize(): number;
  /** 朝向：追饭跑动时设置（镜像由渲染层处理），收场复位。 */
  setFacing(dir: "left" | "right"): void;
}
