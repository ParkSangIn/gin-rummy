const SESSION_KEY = "ginLabPlayOkSessions";
const status = document.getElementById("status");

async function refresh() {
  const stored = await chrome.storage.local.get(SESSION_KEY);
  const sessions = Object.values(stored[SESSION_KEY] || {});
  const snapshots = sessions.reduce((sum, session) => sum + session.snapshots.length, 0);
  const latestSession = sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
  const latestState = latestSession?.snapshots.at(-1);
  const cardState = latestState
    ? latestState.semanticCardsFound ? "카드 DOM 확인됨" : "카드 DOM 미확인"
    : "PlayOK 진러미를 열면 자동 시작";
  status.textContent = `${sessions.length}개 세션 · 상태 ${snapshots}개 · ${cardState}`;
}

document.getElementById("export").addEventListener("click", async () => {
  status.textContent = "파일을 저장하는 중…";
  const result = await chrome.runtime.sendMessage({ type: "gin-lab-export" });
  status.textContent = result.ok ? "JSON 파일 저장 창이 열렸습니다." : `저장 실패: ${result.error}`;
});

document.getElementById("clear").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "gin-lab-clear" });
  await refresh();
});

refresh();
