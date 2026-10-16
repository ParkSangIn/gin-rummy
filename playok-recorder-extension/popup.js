const SESSION_KEY = "ginLabPlayOkSessions";
const status = document.getElementById("status");

async function refresh() {
  const stored = await chrome.storage.local.get(SESSION_KEY);
  const sessions = Object.values(stored[SESSION_KEY] || {});
  const snapshots = sessions.reduce((sum, session) => sum + session.snapshots.length, 0);
  status.textContent = `${sessions.length}개 세션 · 상태 ${snapshots}개 기록됨`;
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
