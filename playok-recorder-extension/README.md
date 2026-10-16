# Gin Lab PlayOK recorder

PlayOK Gin Rummy에서 **화면에 공개된 DOM 정보와 사용자의 클릭만** 브라우저 로컬 저장소에 기록하는 Chrome/Edge 확장 프로그램입니다. 네트워크 패킷, 상대 패, 숨은 덱은 읽지 않습니다. 게임 중 추천이나 자동 입력도 하지 않습니다.

## 설치

1. Chrome 또는 Edge에서 `chrome://extensions`를 엽니다.
2. **개발자 모드**를 켭니다.
3. **압축해제된 확장 프로그램을 로드**를 누르고 이 폴더를 선택합니다.
4. PlayOK Gin Rummy를 열고 평소대로 게임합니다. 기록은 자동으로 시작됩니다.
5. 게임 후 확장 프로그램 아이콘에서 **기록 JSON 저장**을 누릅니다.

그 JSON 파일을 Gin Lab에 가져오는 변환기는 첫 실제 기록에서 PlayOK의 카드 DOM 구조를 확인한 뒤 연결합니다. 팝업에 `semanticCardsFound`가 없는 상태(카드 상태가 canvas에만 그려지는 경우)라면, 기보를 정확히 만들 수 없으므로 DOM 기반 기록기를 계속 사용하지 않습니다.
