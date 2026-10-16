(() => {
  const SESSION_ID = `playok-${Date.now()}-${crypto.randomUUID()}`;
  const CARD_PATTERN = /(?:\b(?:10|[2-9AJQK])[♠♥♦♣SHDC]\b|\b(?:ace|king|queen|jack|ten|[2-9])\s+(?:of\s+)?(?:spades|hearts|diamonds|clubs)\b)/i;
  const ACTION_PATTERN = /(draw|stock|discard|pile|knock|gin|pass|take|card|deck|버림|노크|진|가져|덱|패)/i;
  const FRAME_LIMIT = 120;
  let lastSignature = "";
  let lastCanvasHash = "";
  let frameCount = 0;
  let timer;

  function compact(value) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, 120);
  }

  function publicElementText(element) {
    return compact([
      element.getAttribute("data-card"),
      element.getAttribute("data-rank"),
      element.getAttribute("data-suit"),
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("alt"),
      element.textContent,
    ].filter(Boolean).join(" "));
  }

  function visible(element) {
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  }

  function takeUnique(values, limit) {
    return [...new Set(values.filter(Boolean))].slice(0, limit);
  }

  function largestVisibleCanvas() {
    return [...document.querySelectorAll("canvas")]
      .filter(visible)
      .sort((left, right) => right.width * right.height - left.width * left.height)[0];
  }

  function canvasHash(canvas) {
    try {
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return "unreadable";
      const step = Math.max(16, Math.floor(Math.max(canvas.width, canvas.height) / 32));
      let hash = 2166136261;
      for (let y = 0; y < canvas.height; y += step) {
        for (let x = 0; x < canvas.width; x += step) {
          const pixel = context.getImageData(x, y, 1, 1).data;
          hash ^= pixel[0] | (pixel[1] << 8) | (pixel[2] << 16);
          hash = Math.imul(hash, 16777619);
        }
      }
      return `${canvas.width}x${canvas.height}:${hash >>> 0}`;
    } catch {
      return "unreadable";
    }
  }

  function canvasFrame() {
    const canvas = largestVisibleCanvas();
    if (!canvas) return null;
    const hash = canvasHash(canvas);
    if (hash === lastCanvasHash || frameCount >= FRAME_LIMIT) return { width: canvas.width, height: canvas.height, hash };
    lastCanvasHash = hash;
    try {
      const scale = Math.min(1, 960 / Math.max(canvas.width, canvas.height));
      const copy = document.createElement("canvas");
      copy.width = Math.max(1, Math.round(canvas.width * scale));
      copy.height = Math.max(1, Math.round(canvas.height * scale));
      copy.getContext("2d").drawImage(canvas, 0, 0, copy.width, copy.height);
      const image = copy.toDataURL("image/webp", 0.62);
      frameCount += 1;
      return { width: canvas.width, height: canvas.height, hash, image };
    } catch {
      return { width: canvas.width, height: canvas.height, hash, unreadable: true };
    }
  }

  function snapshot() {
    const all = [...document.querySelectorAll("[data-card], [data-rank], [aria-label], [title], img[alt], button, [role='button']")]
      .filter(visible);
    const labels = all.map(publicElementText);
    const cards = takeUnique(labels.filter((label) => CARD_PATTERN.test(label)), 40);
    const controls = takeUnique(labels.filter((label) => ACTION_PATTERN.test(label)), 30);
    const frame = canvasFrame();
    return {
      at: new Date().toISOString(),
      path: location.pathname,
      title: compact(document.title),
      cards,
      controls,
      // True only when semantic card labels are available; this tells us
      // whether PlayOK can be converted to an exact engine replay.
      semanticCardsFound: cards.length > 0,
      canvas: frame,
    };
  }

  function send(kind, payload) {
    chrome.runtime.sendMessage({
      type: "gin-lab-record",
      record: { kind, sessionId: SESSION_ID, url: location.href, at: new Date().toISOString(), payload },
    }).catch(() => {});
  }

  function capture() {
    const state = snapshot();
    const signature = JSON.stringify({ cards: state.cards, controls: state.controls, path: state.path, canvas: state.canvas?.hash });
    if (signature !== lastSignature) {
      lastSignature = signature;
      send("snapshot", state);
    }
  }

  function scheduleCapture() {
    clearTimeout(timer);
    timer = setTimeout(capture, 700);
  }

  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-card], [data-rank], button, [role='button'], [aria-label], [title], img[alt]");
    if (!target || !visible(target)) return;
    const label = publicElementText(target);
    if (label && (ACTION_PATTERN.test(label) || CARD_PATTERN.test(label))) {
      send("action", { at: new Date().toISOString(), label });
    }
    scheduleCapture();
  }, true);

  new MutationObserver(scheduleCapture).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "aria-label", "title", "alt", "data-card", "data-rank", "data-suit"],
  });
  capture();
})();
