# 워크벤치 공통 발송 연결 제안

이 문서는 제안만 담는다. `/Users/cigro/litmers-workbench-sales`의 코드, overlay, 설치 파일은 변경하지 않았다.

## 확인한 현재 제약

- `_internal/tools/kakao-send/README.md`: npm `agent-messenger@2.39.0` 위에 고정 포크 빌드의 카카오 파일과 공통 줄 간격 검사를 overlay한다. 포크 worktree는 현재 2.40.0이므로 버전과 manifest 계약을 맞춰야 한다.
- `.claude/skills/_scripts/communications_send.py`, `load_job`: 카카오는 숫자 `account`와 `chat_id`를 필수로 요구하고, 첨부는 하나만 허용하며 본문과 첨부의 동시 지정도 거절한다.
- 같은 파일의 `check_kakao_preview`: 기존 `identity`, `chatId`와 단일 첨부의 메타데이터만 검증한다.
- `_internal/tools/kakao-send/src/media.mjs`, `media-transport.mjs`: 단일 파일의 크기와 해시를 고정하고, 1회 시도 및 이력 검증을 별도로 수행한다. SDK를 새로 빌드했다는 이유만으로 이 경로가 `sendFiles`를 사용하게 되지는 않는다.

## job 필드 제안

기존 `chat_id` 방식은 유지하고, 새 상대에는 `recipient`를 추가한다. `chat_id`와 `recipient`는 둘 중 하나만 허용한다.

```json
{
  "channel": "kakao",
  "request_id": "kakao-new-contact-example",
  "account": "<sender-user-id>",
  "profile": "default",
  "recipient": {
    "kind": "phone",
    "phone_number": "01000000000",
    "display_name": "테스트 상대",
    "country_iso": "KR",
    "country_code": "82"
  },
  "body": "승인받을 본문",
  "media_kind": "file",
  "attachments": ["/absolute/path/01.pdf", "/absolute/path/02.pdf"],
  "delivery_order": ["body", "attachments"],
  "file_policy": { "max_file_bytes": 10000000 }
}
```

`file_policy.max_file_bytes`는 조직이 정하는 파일별 제한이다. 예시 10,000,000바이트는 카카오 서버 한도라는 뜻이 아니다. 파일 배열의 순서를 발송 순서로 고정하고, 파일별 크기와 SHA-256을 job digest에 포함한다. `kind: "user_id"`의 경우 `recipient`에 `user_id`와 `display_name`을 넣고 전화번호 필드는 허용하지 않는다. 필요한 경우 `expected_user_id`를 지정해 전화번호로 확인한 ID와 반드시 일치하도록 한다.

## 준비와 승인

1. 로컬 prepare에서는 job 형식, 발신 계정 지정, 파일 존재와 크기, 해시, 순서와 본문을 확인한다. 친구 추가나 방 생성은 prepare의 자동 부수 효과로 실행하지 않는다.
2. 새 상대라면 “수신자 준비” 미리보기에 발신 계정, 입력한 이름과 전화번호, 국가, “연락처 추가 후 1:1 방 생성 가능”, 계정 정보로 아직 확인되지 않은 항목을 표시한다. 이 구체적 변경에 대한 승인을 받은 뒤 `addFriendByPhone`, `openDirectChat`을 각각 1회 호출한다. user_id 방식은 친구 추가를 생략한다.
3. 확인된 `user_id`, 닉네임과 `chat_id`를 별도 recipient binding에 기록한다. 입력 이름과 서버 닉네임을 따로 표시한다. 전화번호 정보가 없거나 일치 항목이 둘 이상이면 멈춘다. 이름 검색으로 대체하지 않는다.
4. 최종 발송 미리보기에 발신자, 입력 전화번호, 입력 이름, 확인한 닉네임, 정확한 `user_id`와 `chat_id`, 기존 방 여부, 본문 전문, 첨부 순서별 파일명/크기/해시, 총 개수/총 용량, 발송 순서를 표시한다. 이 최종안의 사용자 승인 후 발송한다. ID나 파일이 바뀌면 승인을 다시 받아야 한다.

수신자 준비 승인과 발송 승인은 구분해서 기록한다. 기존 prepare 과정에서 외부 쓰기를 조용히 실행하거나, SDK 호출을 공통 승인 절차의 우회 수단으로 쓰지 않는다.

## 발송 결과와 중단 처리

- 기존 단일 파일의 preview, reservation, 1회 전송과 이력 검증 계약을 파일마다 유지한다. 배열 전체에 하나의 성공 표시만 기록하지 않는다.
- 새 `sendFiles`는 파일별 순차 전송과 receipt를 제공하지만 워크벤치 승인 원장, 영속 예약, 파일 해시 불변성, 발신자와 방 구성원 검증을 대신하지 않는다. 기존 transport를 파일별로 호출하는 방법과 SDK batch를 사용하면서 파일별 예약을 연결하는 방법을 검토한다.
- 영수증에는 `request_id`, 발신 `account`, 확인한 `user_id`, `chat_id`, 파일 `index`, 이름, 크기, SHA-256, `log_id`, `status`, `status_code`, 원장 기록과 검증 결과를 남긴다.
- `sent`는 서버 COMPLETE와 유효한 log ID를 받았다는 뜻이다. 기존 이력 검증으로 파일명/크기/본문과 실제 메시지를 대조해야 한다.
- 첫 실패 시 남은 파일을 `skipped`로 기록한다. `unknown`은 중복 발송 위험이 있어 자동 재시도하지 않는다. 이력을 확인하고, 이미 보낸 파일을 제외한 새 job을 다시 미리보기와 승인에 올린다.
- 이 SDK batch의 결과는 프로세스가 살아 있는 동안 보존된다. 프로세스 종료까지 견디는 파일별 원장은 워크벤치가 저장해야 한다.

## overlay 반영 시 별도 할 일

포크 변경의 리뷰와 실계정 확인 이후, 기존 overlay 생성 도구로 배포 기준 버전과 포크 커밋을 고정하고 파일별 해시를 다시 만든다. `friends.js`와 새 command 파일, `client.js`, `types.js` 및 관련 프로토콜 빌드가 누락되지 않아야 한다. 기존 manifest의 버전/원본 해시 검사를 우회하지 않고, 공통 job과 preview 검증의 단위 테스트를 함께 보완한다. 이 작업에서는 overlay 생성이나 배포를 실행하지 않았다.
