const fields = {
  apiKey: document.getElementById("apiKey"),
  model: document.getElementById("model"),
  targetLanguage: document.getElementById("targetLanguage"),
};
const status = document.getElementById("status");

async function load() {
  const settings = await chrome.storage.local.get({
    apiKey: "",
    model: "deepseek-flash",
    targetLanguage: "简体中文",
  });
  Object.entries(fields).forEach(([key, field]) => { field.value = settings[key]; });
}

async function save() {
  await chrome.storage.local.set({
    apiKey: fields.apiKey.value.trim(),
    model: fields.model.value.trim() || "deepseek-flash",
    targetLanguage: fields.targetLanguage.value,
  });
  setStatus("已保存", "success");
}

document.getElementById("save").addEventListener("click", save);
document.getElementById("test").addEventListener("click", async () => {
  try {
    await save();
    setStatus("测试中…", "working");
    const result = await chrome.runtime.sendMessage({ type: "DSIT_TEST_API", requestId: crypto.randomUUID() });
    setStatus(result?.ok ? `连接成功：${result.translation}` : result?.error || "测试失败", result?.ok ? "success" : "error");
  } catch (error) {
    setStatus(error?.message || String(error), "error");
  }
});
document.getElementById("reveal").addEventListener("click", (event) => {
  const reveal = fields.apiKey.type === "password";
  fields.apiKey.type = reveal ? "text" : "password";
  event.currentTarget.textContent = reveal ? "隐藏" : "显示";
});

function setStatus(text, kind) {
  status.textContent = text;
  status.dataset.kind = kind;
}

load();
