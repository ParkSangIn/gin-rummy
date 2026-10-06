# 엔진 API (로컬 단계)

`gin-rummy-engine`을 게임 상태의 단일 원본으로 사용하는 로컬 HTTP 서버입니다.

```powershell
Set-Location engine-integration
& 'C:\Users\park\.cargo\bin\cargo.exe' run --offline
```

서버 주소는 `http://127.0.0.1:8787`입니다. 현재 메모리에 게임을 유지하므로 서버를 재시작하면 진행 중인 게임은 초기화됩니다.

| 요청 | 역할 |
| --- | --- |
| `POST /api/games` | 첫 딜러를 무작위로 정해 새 핸드를 만듭니다. |
| `GET /api/games/{id}` | 내 패, 공개 버림패, 스톡 장수, 상대 패 장수만 반환합니다. |
| `POST /api/games/{id}/actions` | 사람의 한 행동을 엔진으로 검증·적용하고 AI가 응답합니다. |
| `GET /api/games/{id}/review` | 순서가 보존된 행동 기록을 반환합니다. |

행동 요청 예시는 다음과 같습니다.

```json
{ "type": "pass_upcard" }
{ "type": "draw_stock" }
{ "type": "draw_discard" }
{ "type": "discard", "card": "4H" }
{ "type": "knock", "card": "4H" }
```

`knock`은 현재 남은 패의 최적 meld를 엔진의 `best_melds`로 계산해 제출합니다. 브라우저에서 meld를 직접 고르는 UI를 연결할 단계에서는 그 선택값을 API에 함께 전달하도록 확장합니다.

## 검증한 규칙

- 첫 딜러는 무작위입니다.
- 첫 업카드는 비딜러, 딜러 순으로 제안됩니다.
- 양측 PASS 뒤에도 첫 업카드는 버림패에 남고, 비딜러만 강제 스톡 드로우합니다.
- API는 상대의 카드 내용이나 스톡 순서를 전송하지 않습니다.
- AI는 `gin-rummy-engine`의 기본 `MonteCarloBot`으로 행동합니다.
