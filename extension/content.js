(() => {
  const MAX_SELECTION_LENGTH = 12000;
  const host = document.createElement("div");
  host.id = "dsit-selection-translator-host";
  host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
  document.documentElement.appendChild(host);

  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      * { box-sizing: border-box; }
      #icon {
        position: fixed; display: none; place-items: center; width: 32px; height: 32px;
        padding: 0; border: 1px solid rgba(255,255,255,.24); border-radius: 10px;
        background: linear-gradient(145deg,#8b7cff,#5545dd); color: #fff;
        box-shadow: 0 7px 24px rgba(40,28,130,.35); cursor: pointer; pointer-events: auto;
        font: 700 14px/1 system-ui,-apple-system,"Segoe UI",sans-serif;
        transition: transform .12s ease, box-shadow .12s ease;
      }
      #icon:hover { transform: translateY(-1px) scale(1.04); box-shadow: 0 9px 28px rgba(40,28,130,.43); }
      #icon:active { transform: scale(.96); }
      #panel {
        position: fixed; display: none; width: min(390px, calc(100vw - 24px)); max-height: min(480px, calc(100vh - 24px));
        overflow: hidden; border: 1px solid rgba(255,255,255,.12); border-radius: 15px;
        background: rgba(20,20,27,.98); color: #f5f5f8; box-shadow: 0 18px 55px rgba(0,0,0,.34);
        pointer-events: auto; font: 14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;
        backdrop-filter: blur(18px);
      }
      .head { display:flex; align-items:center; justify-content:space-between; height:46px; padding:0 12px 0 15px; border-bottom:1px solid #30303a; }
      .brand { display:flex; align-items:center; gap:8px; font-size:13px; font-weight:700; }
      .brand-dot { width:9px; height:9px; border-radius:50%; background:#7869ff; box-shadow:0 0 0 4px rgba(120,105,255,.14); }
      .head-actions { display:flex; gap:4px; }
      .mini { display:grid; place-items:center; width:30px; height:30px; padding:0; border:0; border-radius:8px; background:transparent; color:#aaaab8; cursor:pointer; font:16px/1 system-ui; }
      .mini:hover { background:#2a2a34; color:#fff; }
      .body { max-height: 390px; overflow:auto; padding:14px 15px 16px; }
      .label { margin-bottom:5px; color:#858594; font-size:11px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; }
      #source { margin:0 0 13px; color:#b6b6c1; font-size:12px; line-height:1.55; white-space:pre-wrap; overflow-wrap:anywhere; }
      .divider { height:1px; margin:0 0 13px; background:#30303a; }
      #result { min-height:24px; margin:0; color:#fff; white-space:pre-wrap; overflow-wrap:anywhere; user-select:text; }
      #meta { margin-top:10px; color:#717180; font-size:10px; }
      .loading { display:flex; align-items:center; gap:9px; color:#aaaab8; }
      .spinner { width:16px; height:16px; border:2px solid #3a3948; border-top-color:#8476ff; border-radius:50%; animation:spin .75s linear infinite; }
      .error { color:#ff8f8f !important; }
      .copied { color:#72de8c !important; }
      @keyframes spin { to { transform:rotate(360deg); } }
      @media (prefers-color-scheme: light) {
        #panel { border-color:#dddde7; background:rgba(255,255,255,.98); color:#17171d; box-shadow:0 18px 55px rgba(30,30,50,.2); }
        .head { border-bottom-color:#e7e7ed; } .mini:hover { background:#eeeef4; color:#111; }
        #source { color:#5f5f6b; } .divider { background:#e7e7ed; } #result { color:#17171d; }
        .loading { color:#737380; } .spinner { border-color:#dfdfea; border-top-color:#6d5dfc; }
      }
    </style>
    <button id="icon" type="button" title="翻译所选文本" aria-label="翻译所选文本">译</button>
    <section id="panel" role="dialog" aria-label="划词翻译">
      <div class="head">
        <div class="brand"><span class="brand-dot"></span><span>DeepSeek 划词翻译</span></div>
        <div class="head-actions">
          <button id="copy" class="mini" type="button" title="复制译文" aria-label="复制译文">⧉</button>
          <button id="close" class="mini" type="button" title="关闭" aria-label="关闭">×</button>
        </div>
      </div>
      <div class="body">
        <div class="label">原文</div>
        <p id="source"></p>
        <div class="divider"></div>
        <div class="label">译文</div>
        <div id="result"></div>
        <div id="meta"></div>
      </div>
    </section>`;

  const icon = root.getElementById("icon");
  const panel = root.getElementById("panel");
  const sourceNode = root.getElementById("source");
  const resultNode = root.getElementById("result");
  const metaNode = root.getElementById("meta");
  const copyButton = root.getElementById("copy");

  let selectedText = "";
  let selectionRect = null;
  let translationText = "";
  let requestSequence = 0;
  let activeRequestId = null;

  document.addEventListener("mouseup", handleSelectionEnd, true);
  document.addEventListener("keyup", (event) => {
    if (!event.isTrusted) return;
    if (event.key === "Escape") return closeAll();
    if (event.shiftKey || ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      handleSelectionEnd(event);
    }
  }, true);
  document.addEventListener("mousedown", (event) => {
    if (!event.isTrusted) return;
    if (!event.composedPath().includes(host)) hideIcon();
  }, true);
  window.addEventListener("scroll", hideIcon, true);
  window.addEventListener("resize", hideIcon, true);

  icon.addEventListener("pointerdown", (event) => event.preventDefault());
  icon.addEventListener("click", translateSelection);
  root.getElementById("close").addEventListener("click", (event) => { if (event.isTrusted) closePanel(); });
  copyButton.addEventListener("click", (event) => { if (event.isTrusted) copyTranslation(); });

  function handleSelectionEnd(event) {
    if (!event?.isTrusted) return;
    if (event?.composedPath?.().includes(host)) return;
    setTimeout(() => {
      const selection = readSelection();
      if (!selection?.text || selection.text.length > MAX_SELECTION_LENGTH) {
        hideIcon();
        return;
      }
      selectedText = selection.text;
      selectionRect = selection.rect;
      showIcon(selectionRect);
    }, 0);
  }

  function readSelection() {
    const active = document.activeElement;
    if (active && (active.tagName === "TEXTAREA" || (active.tagName === "INPUT" && /^(text|search|url|email|tel)$/i.test(active.type)))) {
      const start = active.selectionStart;
      const end = active.selectionEnd;
      const text = start !== null && end !== null ? active.value.slice(start, end).trim() : "";
      if (!text) return null;
      const rect = active.getBoundingClientRect();
      return { text, rect: { left: rect.right - 8, right: rect.right, top: rect.bottom - 8, bottom: rect.bottom } };
    }

    const selection = window.getSelection();
    const text = selection?.toString().replace(/\u00a0/g, " ").trim();
    if (!text || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    const rects = range.getClientRects();
    const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return null;
    return { text, rect };
  }

  function showIcon(rect) {
    closePanel();
    icon.style.display = "grid";
    const left = clamp(rect.right + 7, 8, window.innerWidth - 40);
    const preferredTop = rect.bottom + 7;
    const top = preferredTop + 34 < window.innerHeight ? preferredTop : Math.max(8, rect.top - 39);
    icon.style.left = `${left}px`;
    icon.style.top = `${top}px`;
  }

  async function translateSelection(event) {
    if (!event?.isTrusted) return;
    const text = selectedText;
    const rect = selectionRect;
    if (!text || !rect) return;
    hideIcon();
    showPanel(rect);
    sourceNode.textContent = text;
    resultNode.className = "";
    resultNode.innerHTML = '<div class="loading"><span class="spinner"></span><span>正在翻译…</span></div>';
    metaNode.textContent = "";
    translationText = "";
    copyButton.disabled = true;

    const sequence = ++requestSequence;
    const requestId = crypto.randomUUID();
    activeRequestId = requestId;
    try {
      const response = await chrome.runtime.sendMessage({ type: "DSIT_TRANSLATE_TEXT", text, requestId });
      if (sequence !== requestSequence) return;
      if (!response?.ok) throw new Error(response?.error || "翻译请求失败");
      translationText = response.translation;
      resultNode.textContent = translationText;
      copyButton.disabled = false;
      const tokens = (response.usage?.prompt_tokens || 0) + (response.usage?.completion_tokens || 0);
      metaNode.textContent = tokens ? `${tokens} tokens` : "";
      requestAnimationFrame(() => positionPanel(rect));
    } catch (error) {
      if (sequence !== requestSequence) return;
      resultNode.className = "error";
      resultNode.textContent = error?.message || String(error);
      requestAnimationFrame(() => positionPanel(rect));
    } finally {
      if (activeRequestId === requestId) activeRequestId = null;
    }
  }

  function showPanel(rect) {
    panel.style.display = "block";
    panel.style.visibility = "hidden";
    positionPanel(rect);
    panel.style.visibility = "visible";
  }

  function positionPanel(rect) {
    const panelRect = panel.getBoundingClientRect();
    const left = clamp(rect.left, 12, window.innerWidth - panelRect.width - 12);
    const below = rect.bottom + 10;
    const top = below + panelRect.height <= window.innerHeight - 12
      ? below
      : Math.max(12, rect.top - panelRect.height - 10);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  async function copyTranslation() {
    if (!translationText) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(translationText);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = translationText;
      textarea.style.cssText = "position:fixed;left:-9999px;top:0;";
      host.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      if (!copied) {
        metaNode.textContent = "复制失败，请手动选择译文复制";
        return;
      }
    }
    metaNode.className = "copied";
    metaNode.textContent = "已复制译文";
    setTimeout(() => { metaNode.className = ""; }, 1200);
  }

  function hideIcon() {
    icon.style.display = "none";
  }

  function closePanel() {
    panel.style.display = "none";
    requestSequence += 1;
    if (activeRequestId) {
      chrome.runtime.sendMessage({ type: "DSIT_CANCEL", requestId: activeRequestId }).catch(() => {});
      activeRequestId = null;
    }
  }

  function closeAll() {
    hideIcon();
    closePanel();
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), Math.max(min, max));
  }
})();
