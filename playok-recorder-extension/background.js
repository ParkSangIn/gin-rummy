const SESSION_KEY = "ginLabPlayOkSessions";
const queues = new Map();

function localTimestamp() {
  const now = new Date();
  const part = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${part(now.getMonth() + 1)}-${part(now.getDate())}_${part(now.getHours())}-${part(now.getMinutes())}-${part(now.getSeconds())}`;
}

function queue(tabId, work) {
  const previous = queues.get(tabId) || Promise.resolve();
  const next = previous.then(work, work).finally(() => {
    if (queues.get(tabId) === next) queues.delete(tabId);
  });
  queues.set(tabId, next);
  return next;
}

async function appendRecord(tabId, record) {
  const stored = await chrome.storage.local.get(SESSION_KEY);
  const sessions = stored[SESSION_KEY] || {};
  const id = record.sessionId;
  const session = sessions[id] || {
    id,
    url: record.url,
    startedAt: record.at,
    updatedAt: record.at,
    snapshots: [],
    actions: [],
  };
  session.updatedAt = record.at;
  if (record.kind === "snapshot") {
    // This is a study recorder, not an unlimited page archive.
    if (session.snapshots.length < 4000) session.snapshots.push(record.payload);
  } else if (record.kind === "action" && session.actions.length < 2000) {
    session.actions.push(record.payload);
  }
  sessions[id] = session;
  await chrome.storage.local.set({ [SESSION_KEY]: sessions });
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === "gin-lab-record" && sender.tab?.id != null) {
    queue(sender.tab.id, () => appendRecord(sender.tab.id, message.record))
      .then(() => respond({ ok: true }))
      .catch((error) => respond({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type === "gin-lab-export") {
    chrome.storage.local.get(SESSION_KEY).then(async (stored) => {
      const payload = JSON.stringify({
        format: "gin-lab-playok-recorder/v1",
        exportedAt: new Date().toISOString(),
        sessions: Object.values(stored[SESSION_KEY] || {}),
      }, null, 2);
      const url = `data:application/json;charset=utf-8,${encodeURIComponent(payload)}`;
      const id = await chrome.downloads.download({
        url,
        filename: `gin-lab-playok-${localTimestamp()}.json`,
        saveAs: true,
      });
      respond({ ok: true, id });
    }).catch((error) => respond({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type === "gin-lab-clear") {
    chrome.storage.local.remove(SESSION_KEY).then(() => respond({ ok: true }));
    return true;
  }
});
