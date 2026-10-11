const DEFAULTS = { apiKey: "", model: "deepseek-flash", targetLanguage: "简体中文" };
const pending = new Map();
const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
let admission = Promise.resolve();

chrome.runtime.onInstalled.addListener(async () => {
  await storageReady;
  const current = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const missing = Object.fromEntries(Object.entries(DEFAULTS).filter(([key]) => current[key] === undefined));
  if (Object.keys(missing).length) await chrome.storage.local.set(missing);
});

function ownerOf(sender, type) {
  if (sender.id !== chrome.runtime.id) throw new Error("无效的请求来源");
  if (type === "DSIT_TEST_API") {
    if (sender.url !== chrome.runtime.getURL("options.html")) throw new Error("请从设置页测试连接");
    return "options";
  }
  if (!Number.isInteger(sender.tab?.id) || !/^https?:\/\//i.test(sender.url || "")) throw new Error("无效的页面来源");
  return `${sender.tab.id}:${sender.documentId || sender.frameId || 0}`;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!["DSIT_TRANSLATE_TEXT", "DSIT_TEST_API", "DSIT_CANCEL"].includes(message?.type)) return false;
  const run = async () => {
    const owner = ownerOf(sender, message.type);
    if (message.type === "DSIT_CANCEL") {
      await admission;
      const item = pending.get(owner);
      if (item?.id === message.requestId) item.controller.abort();
      return { ok: true };
    }
    const input = message.type === "DSIT_TEST_API" ? "The quick brown fox jumps over the lazy dog." : message.text;
    if (typeof input !== "string" || !input.trim() || input.length > 12000) throw new Error("请选择 1–12000 字符的文本");
    if (typeof message.requestId !== "string" || !/^[\w-]{1,80}$/.test(message.requestId)) throw new Error("无效的请求编号");
    // Serialize admission, including storage operations, to avoid concurrent limit bypasses.
    const reserve = admission.then(async () => {
      await storageReady;
      if (pending.has(owner)) throw new Error("上一条请求正在结束，请稍后再试");
      if (pending.size >= 3) throw new Error("正在处理其他翻译，请稍后再试");
      const now = Date.now();
      const { requestTimes = [] } = await chrome.storage.session.get("requestTimes");
      const recent = requestTimes.filter((time) => Number.isFinite(time) && now - time < 60000);
      if (recent.length >= 10) throw new Error("请求过于频繁，请一分钟后重试");
      await chrome.storage.session.set({ requestTimes: [...recent, now] });
      const item = { id: message.requestId, controller: new AbortController() };
      pending.set(owner, item);
      return item;
    });
    admission = reserve.catch(() => {});
    const item = await reserve;
    try { return { ok: true, ...(await translateText(input.trim(), item.controller)) }; }
    finally { if (pending.get(owner) === item) pending.delete(owner); }
  };
  run().then(respond, (error) => respond({ ok: false, error: friendlyError(error) }));
  return true;
});

async function translateText(text, controller) {
  const settings = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
  if (!settings.apiKey?.trim()) throw new Error("请先在插件设置里填写 DeepSeek API Key");
  if (controller.signal.aborted) throw new DOMException("取消请求", "AbortError");
  const timeout = setTimeout(() => controller.abort(), 25000);
  let onAbort;
  try {
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(new DOMException("取消或超时", "AbortError"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    const work = async () => {
      const response = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.apiKey.trim()}` },
        body: JSON.stringify({
          model: settings.model || DEFAULTS.model,
          messages: [
            { role: "system", content: `Translate the user's text into ${settings.targetLanguage}. Preserve meaning, tone, names, numbers, punctuation and paragraph breaks. Return only the translation.` },
            { role: "user", content: text },
          ],
          thinking: { type: "disabled" },
          max_tokens: Math.min(8192, Math.max(800, Math.ceil(text.length * 1.5))), stream: false,
        }),
      });
      if (!response.ok) throw new Error(`DeepSeek API 请求失败（HTTP ${response.status}），请检查密钥、余额或稍后重试`);
      // Keep both body reading and JSON parsing inside the deadline.
      const data = await response.json();
      const translation = data?.choices?.[0]?.message?.content;
      if (typeof translation !== "string" || !translation.trim()) throw new Error("DeepSeek 返回内容为空或格式异常");
      return { translation: translation.trim(), usage: data.usage || null };
    };
    return await Promise.race([work(), cancelled]);
  } finally {
    clearTimeout(timeout);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

function friendlyError(error) {
  if (error?.name === "AbortError") return "请求已取消或超过 25 秒，请手动重试";
  // Network exceptions can contain endpoint details; server bodies are never forwarded.
  return error?.message || "翻译失败，请重试";
}
