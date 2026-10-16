(() => {
  const SESSION_ID = `playok-${Date.now()}-${crypto.randomUUID()}`;
  const CARD_PATTERN = /(?:\b(?:10|[2-9AJQK])[♠♥♦♣SHDC]\b|\b(?:ace|king|queen|jack|ten|[2-9])\s+(?:of\s+)?(?:spades|hearts|diamonds|clubs)\b)/i;
  const ACTION_PATTERN = /(draw|stock|discard|pile|knock|gin|pass|take|card|deck|버림|노크|진|가져|덱|패)/i;
  let lastSignature = "";
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

  function snapshot() {
    const all = [...document.querySelectorAll("[data-card], [data-rank], [aria-label], [title], img[alt], button, [role='button']")]
      .filter(visible);
    const labels = all.map(publicElementText);
    const cards = takeUnique(labels.filter((label) => CARD_PATTERN.test(label)), 40);
    const controls = takeUnique(labels.filter((label) => ACTION_PATTERN.test(label)), 30);
    return {
      at: new Date().toISOString(),
      path: location.pathname,
      title: compact(document.title),
      cards,
      controls,
      // True only when semantic card labels are available; this tells us
      // whether PlayOK can be converted to an exact engine replay.
      semanticCardsFound: cards.length > 0,
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
    const signature = JSON.stringify({ cards: state.cards, controls: state.controls, path: state.path });
    if (signature !== lastSignature) {
      lastSignature = signature;
      send("snapshot", state);
    }
  }

  function scheduleCapture() {
    clearTimeout(timer);
    timer = setTimeout(capture, 250);
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
