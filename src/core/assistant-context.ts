// 设置助手状态快照的扩展点（core 层，零业务依赖）。
//
// app_status 要回答「QQ / 微信连上没」这类上层状态，但分层规则只允许向下依赖：
// mind 不能反过来 import channels。做法与 core/reminder-slot.ts 一致——把共享读口
// 下沉到零依赖叶子，由 channels 层在装配时登记 provider，mind 层只从这里取。
//
// provider 必须同步、只读、无副作用：助手每一轮拼提示词都会调用它。抛错不拖垮
// 整轮对话，降级成一条 error 字段，让助手如实说「这部分状态没读到」而不是猜。
// 返回的字段一律不含凭据、密钥与错误全文（那些由状态页自己展示）。

export type AssistantStatusProvider = () => Record<string, unknown>;

const providers = new Map<string, AssistantStatusProvider>();

export function registerAssistantStatusProvider(key: string, provider: AssistantStatusProvider): void {
  providers.set(key, provider);
}

export function assistantStatusExtensions(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, provider] of providers) {
    try {
      out[key] = provider();
    } catch (error) {
      out[key] = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  return out;
}
