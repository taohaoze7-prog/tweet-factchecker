// 用户设置：API Key 的读写。
//
// 存 chrome.storage.local 而非 sync：sync 会把 key 同步到用户所有登录设备
// 并经 Google 服务器中转，对一枚可计费的凭证来说是不必要的扩散面。
// local 只留在本机，卸载扩展即随之清除。

const KEY_FIELD = "anthropic_api_key";

export async function getApiKey(): Promise<string> {
  const store = await chrome.storage.local.get(KEY_FIELD);
  const v = store[KEY_FIELD];
  return typeof v === "string" ? v : "";
}

export async function setApiKey(key: string): Promise<void> {
  await chrome.storage.local.set({ [KEY_FIELD]: key.trim() });
}

export async function clearApiKey(): Promise<void> {
  await chrome.storage.local.remove(KEY_FIELD);
}

/** 形状预检：省掉一次注定失败的网络往返，也挡住误粘贴的 OpenAI key。*/
export function looksLikeAnthropicKey(key: string): boolean {
  return /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key.trim());
}

/** 打码显示：让用户确认存的是哪一枚，又不在屏幕上暴露完整凭证。*/
export function maskKey(key: string): string {
  if (key.length <= 12) return "••••";
  return `${key.slice(0, 8)}••••${key.slice(-4)}`;
}
