import MediaLibrary from "../../components/MediaLibrary";
import EmoteFrequencySection from "./EmoteFrequencySection";
import type { SettingsForm } from "./useSettingsForm";

/**
 * 「媒体与表情」：全局媒体库。
 *
 * 这些原来散在 设置 → 模型与能力 → 表情 里。那个位置把「联系人有什么」框成了
 * 「配置一个能力」，而它和联系人页的媒体看的是同一批东西——现在只有一处库，
 * 联系人页那个是它带了一个筛选条件。
 *
 * 添加动作（上传/导入/自动收录）不在这里单独开卡：它们服务的就是表情包，
 * 入口收在媒体库的表情包视角工具行里——一屏一个主语，页头顶不再压一张突兀的大卡片。
 * 渠道能力（官方会把内置表情降级成 emoji）与内置表情词表也不在这里：那是 QQ 通道的事实，
 * 跟着 QQ 卡片走，见 features/profile/QQSection.tsx。
 */
export default function MediaSection({ active = true, form }: { active?: boolean; form: SettingsForm }): JSX.Element {
  return (
    <div className="section" id="settings-media">
      <h2>媒体与表情</h2>
      <div className="desc">
        图片、视频、语音和表情素材，一处管理。
      </div>
      <MediaLibrary active={active} />
      <EmoteFrequencySection form={form} />
    </div>
  );
}
