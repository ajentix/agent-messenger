# 카카오톡 1:1 방 열기와 파일 순차 전송

기준: 2026-11-03 실계정 확인 결과, 2026-11-04 기능 정리. 작업 위치는 `kakao-new-dm-files-261103` worktree다. 이번 정리에서는 실제 카카오 접속, 로그인, 발송을 하지 않는다.

## 남긴 기능과 확인 범위

| 기능 | 남긴 구현 | 확인 결과 |
| --- | --- | --- |
| user_id로 1:1 방 열기 | SDK `openDirectChat`, CLI `chat open` | 실계정 통과. 기존 방이면 같은 방과 `existing: true` 반환 확인 |
| 단일 파일 전송 | `sendFile`, `message upload <chat-id> <path> --as file`, 업로더 변경 | overlay로 실계정 발송 후 이력 대조 성공 |
| 여러 파일 순차 전송 | SDK `sendFiles`, 여러 경로를 받는 `message upload ... --as file` | 확인된 단일 FILE 경로를 입력 순서대로 호출. 다중 파일 순서, 개별 결과, 실패 시 중단은 오프라인 테스트로 검증. 실계정 다중 파일 묶음은 미확인 |
| 호출자 파일 크기 제한 | SDK `maxFileBytes`, CLI `--max-file-bytes` | 전체 파일을 첫 전송 전에 검사하는 오프라인 테스트 유지. 카카오 서버 한도와는 별개 |

전화번호 친구 추가는 “실계정 1101 거절로 제외”했다. 원인은 미확인이다. 친구 목록은 실계정으로 호출하지 않아 제외했다. 두 기능의 SDK 메서드, CLI `friend` 명령, 전용 타입과 schema, 테스트, HTTP 모듈과 참조 자료를 제거했다.

기존 텍스트, 사진 갤러리, 영상, 음성, 방 목록과 구성원 조회 기능은 유지한다. 다른 기능이 사용하는 큰 정수 보존 JSON 파서도 유지한다. 중앙 아카이브 폐기로 불필요해진 `docs/kakaotalk-workbench-proposal-261103.md`는 삭제했다.

## CLI와 SDK

아래는 사용 예시다. 이번 정리 작업에서는 실행하지 않는다.

```bash
agent-kakaotalk chat open <user-id> --account <account-id> --pretty
agent-kakaotalk message upload <chat-id> ./one.pdf --as file --account <account-id> --pretty
agent-kakaotalk message upload <chat-id> ./one.pdf ./two.pdf --as file --account <account-id> --pretty
agent-kakaotalk message upload <chat-id> ./one.pdf ./two.pdf --as file --max-file-bytes 10000000
```

```typescript
import { readFile } from 'node:fs/promises'
import { KakaoTalkClient } from 'agent-messenger/kakaotalk'

const client = new KakaoTalkClient()
try {
  await client.login(undefined, '<account-id>')
  const room = await client.openDirectChat('<verified-user-id>')
  const result = await client.sendFiles(room.chat_id, [
    { data: await readFile('./one.pdf'), filename: 'one.pdf' },
    { data: await readFile('./two.pdf'), filename: 'two.pdf' },
  ], { maxFileBytes: 10_000_000 })
  console.log(result)
} finally {
  await client.close()
}
```

`openDirectChat`는 전체 방 목록과 구성원 ID로 정상 `DirectChat`을 확인한다. 기존 방이면 `existing: true`를 반환하고, 없으면 `CREATE { memberIds: [Long] }`를 한 번 요청한다. 메시지는 보내지 않는다. 목록이나 구성원 조회가 불완전하거나 방이 모호하면 중단한다. 숫자 방 타입은 CHATINFO로 확인하며 끝까지 식별되지 않으면 오류로 처리한다. 입력과 출력 ID는 64비트 정밀도를 보존한다.

`existing: false`는 SDK가 CREATE를 요청했다는 뜻이며 다른 프로세스의 동시 작업까지 포함한 서버 신규 생성 여부를 증명하지는 않는다. 같은 SDK 인스턴스의 동시 요청은 합치고 생성한 방은 세션 snapshot에 반영한다. 응답 유실 후 CREATE를 자동 재시도하지 않는다.

`sendFiles`는 각 입력을 FILE(18)로 보내며 SHIP/POST/COMPLETE가 끝나야 다음 파일을 시작한다. 결과는 `KakaoAttachmentBatchResult`로, 각 파일의 입력 index, 이름, 크기, 상태, log ID, 시간, 서버 상태와 오류를 보존한다. 상태는 `sent`, `failed`, `unknown`, `skipped`이며 확인되지 않은 log ID는 `null`이다. 첫 실패나 불명확한 결과에서 후속 전송을 중단하고 완료된 결과는 유지한다. CLI는 부분 실패도 JSON으로 출력하고 종료 코드 1을 반환한다.

단일 `upload --as file`은 기존 단일 메시지 JSON 형식을 유지한다. 여러 이미지는 기존 갤러리 경로를 사용하며 `--as file`을 지정하면 각각 일반 파일로 전송한다. `sendAttachment([...])`의 기존 반환 형식도 유지한다.

## 프로토콜 근거와 제한

`research/kakaotalk/node-kakao/`에는 공개 `storycraft/node-kakao` 커밋 `8512e4699e2cd4c26516b80d38b57b2f85a6cc8a`의 1:1 방 생성 근거 4개와 MIT license, SHA-256 manifest를 남겼다. 원본 snapshot은 수정하지 않았으며 runtime 의존성이 아니다.

- `src/talk/channel/talk-channel-session.ts.txt`: CREATE의 `memberIds` 요청
- `src/packet/chat/create.ts.txt`: 응답의 `chatId: Long`
- `src/channel/channel-type.ts.txt`: `DirectChat` 구분
- `src/request/index.ts.txt`: 알려진 서버 거절 상태

파일은 포크의 `protocol/session.ts`와 `protocol/media-uploader.ts`에 있는 SHIP/POST/COMPLETE 경로를 재사용한다. POST가 거절되면 파일 바이트를 보내지 않는다. COMPLETE 성공과 유효한 log ID 없이 발송 성공으로 처리하지 않는다. 각 첨부의 쓰기를 자동 재전송하지 않는다.

카카오 서버의 현재 파일별 크기, 선택 묶음별 총 용량, 갤러리 최대 개수는 확정하지 않았다. 순차 FILE 전송에는 SDK 자체 개수나 총 용량 제한을 추가하지 않았지만 서버의 파일별 제한과 호출 속도 제한은 적용될 수 있다. 결과는 영속 발송 원장이 아니며 프로세스 종료 후 복구나 응답 유실 시 이력 대조는 호출자가 처리한다.

## 정리 후 검증

`AGENT_MESSENGER_CONFIG_DIR`을 새 임시 경로로 지정해 검증했다. 테스트는 fake 세션과 fake 업로드를 사용하며 실제 계정에 접속하는 E2E는 실행하지 않았다.

| 검증 | 2026-11-04 결과 |
| --- | --- |
| `bun run test` | 4,197 pass, 0 fail, 284개 파일, 8,604 assertions |
| `bun run typecheck` | 통과 |
| `bun run build` | 통과. Node shebang과 vendored runtime 후처리 포함 |
| `bun run lint` | 오류 0, 기존 Teams 경고 4개 |
| 변경 TypeScript의 `oxfmt --check` | 통과 |
| 고정 참조 소스 SHA-256 | 4개 모두 manifest와 일치 |
| 빌드된 SDK와 Node CLI 도움말 | 친구 메서드와 schema 및 CLI 제거 확인. `openDirectChat`, `sendFiles`, 관련 schema와 도움말 유지 확인. 로그인이나 서버 호출 없음 |

origin/main 병합 상태는 작업 완료 보고에 기록한다.

유지한 테스트 범위는 기존 방과 새 방, 동시/반복 호출, CREATE 거절과 불완전 응답, 7개 FILE 파이프라인, 파일 크기 사전 검사, SHIP/POST/COMPLETE 실패, 응답 유실, 부분 성공과 CLI 실패 종료다.
