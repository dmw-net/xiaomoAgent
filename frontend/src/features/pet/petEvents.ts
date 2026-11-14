/**
 * 桌宠设置变更的页内广播（与 App 里 xiaomo:open-contact 等页面事件同一套路）。
 * 保存桌宠设置的所有路径（设置页表单、桌宠菜单里的开关）发这里；
 * PetHost 收到后重拉快照，内嵌桌宠的挂/卸/体型随之实时生效。
 * 只发信号不带数据：让 PetHost 统一拉取，避免每个保存点各自拼快照。
 */
export const PET_SETTINGS_EVENT = "xiaomo:pet-settings";

export function emitPetSettingsChanged(): void {
  window.dispatchEvent(new CustomEvent(PET_SETTINGS_EVENT));
}
