# 카카오톡 새 상대와 여러 파일 지원 조사 및 구현

기준: 2026-11-03, `kakao-new-dm-files-261103` worktree. 실제 카카오 서버 접속, 계정 로그인, 인증 파일이나 토큰 조회, 친구 추가, 방 생성, 메시지 발송은 하지 않았다. 변경은 이 worktree 안에만 있으며 commit, push, 배포를 하지 않았다.

## 기존 지원 기능과 이번 변경

| 기능 | 변경 전 | 이번 변경과 근거 |
| --- | --- | --- |
| 텍스트 | 기존 방에 `message send`, SDK `sendMessage`. 답장, 멘션, 수정도 지원 | 기존 동작 유지. `client.ts`, `commands/message.ts`, `protocol/session.ts`의 WRITE/REPLY/MODIFYMSG |
| 사진 | 단일 사진, 여러 사진 갤러리. 확장자/MIME에 따라 자동 분기 | 이미지 여러 개는 기존 갤러리 유지. 갤러리는 이미지 전용임을 CLI에서 확인 |
| 영상과 음성 | 단일 영상/음성. MP4/MOV/WEBM/MKV/M4V, M4A/MP3/WAV/OGG 등 확장자 매핑 | 기존 동작 유지. `media-upload.ts`, `attachment-router.ts`, `sendVideo`, `sendAudio` |
| 일반 파일 | PDF, 문서, ZIP 등 일반 파일을 FILE(18)로 전송. SDK는 알려지지 않은 확장자도 일반 파일로 분기. 서버에서 허용하는지는 별개 | 단일 `sendFile`, 단일 `upload --as file` JSON 형식 유지 |
| 파일 여러 개 | SDK `sendAttachment([...])`는 혼합 첨부를 순차 처리하지만 마지막 결과만 반환. CLI는 경로가 2개 이상이면 모두 사진 묶음으로 처리 | `sendFiles` 추가. CLI의 여러 문서 또는 `--as file`을 순차 FILE 전송으로 변경. 입력별 결과와 log ID 보존 |
| 파일 크기 | 코드에 확인된 카카오 서버 크기 한도 없음 | 선택 가능한 호출자 제한 `maxFileBytes`, CLI `--max-file-bytes`. 전체 파일을 사전 검사. SHIP/POST/COMPLETE 거절 시 단계와 상태 코드, 해당 파일의 크기를 확인 가능 |
| 한 번에 몇 개 | 단일 media는 1개. 갤러리는 2개 이상이지만 코드에 검증된 최대 개수 없음 | 순차 FILE batch에는 SDK 개수/총 용량 제한을 추가하지 않음. 7개도 각각 독립 전송. 서버의 파일별 제한과 호출 속도 제한은 적용될 수 있음 |
| 친구 목록 | 미지원. `member list`는 방 구성원 목록이므로 친구 목록과 다름 | `friend list`, SDK `getFriends` 추가. node-kakao `requestFriendList` 근거 |
| 전화번호 친구 추가 | 미지원 | `friend add-phone`, SDK `addFriendByPhone`. 이름/전화번호/국가를 form으로 보내고 친구 목록의 전화번호에서 ID 확인 |
| 방 목록 | `chat list`, `--all`, `--search`, `--resolve-titles` 지원 | 기존 목록/구성원 기능을 1:1 방 중복 확인에 사용 |
| 새 방 | 미지원 | `chat open`, SDK `openDirectChat`. 일치하는 정상 DirectChat 재사용, 없으면 `CREATE { memberIds: [Long] }` 1회 |

사진 자동 매핑은 JPEG, PNG, GIF, WebP이며 실제 크기/형식 해석은 `image-meta.ts`를 따른다. MIME 매핑은 업로드 가능 확장자의 서버 허용 목록을 뜻하지 않는다. 기존 갤러리의 최대 개수나 총 용량은 이 조사로 확정하지 못했다.

## 프로토콜 근거

공개 `storycraft/node-kakao`의 고정 커밋 `8512e4699e2cd4c26516b80d38b57b2f85a6cc8a`를 참조했다. 원본 파일과 MIT license, SHA-256 manifest를 `research/kakaotalk/node-kakao/`에 보관했다. 구현 코드는 포크에 새로 작성했고 참조 소스는 runtime 의존성이 아니다.

- 전화번호 추가: `src/api/service-api-client.ts.txt`, `addFriendWithPhoneNumber`, `friends/add_by_phonenumber.json`, form의 `nickname`, `country_iso`, `country_code`, `phonenumber`.
- 반환 ID 확인: `friend-req-struct.ts.txt`는 `pstn_number`만 보장한다. 따라서 `requestFriendList`의 `friends/list.json`과 `friend-struct.ts.txt`의 `userId`, `phoneNumber`를 사용한다. 이름만으로 ID를 선택하지 않는다.
- 1:1 방: `src/talk/channel/talk-channel-session.ts.txt`의 `TalkChannelManageSession.createChannel`, `src/packet/chat/create.ts.txt`의 `chatId: Long`. 입력 ID와 출력 ID를 64비트 정밀도 손실 없이 처리한다.
- 파일: 포크의 `protocol/session.ts` 및 `protocol/media-uploader.ts`에 이미 있는 SHIP/POST/COMPLETE를 각 파일에 적용한다. PDF 묶음용 가상 엔드포인트나 일반 파일용 MSHIP을 만들지 않았다.

상세 참조 색인은 `research/kakaotalk/README.md`에 있다. 공개 소스가 현재 서버 버전에서 그대로 동작한다는 보장은 실계정 확인이 필요하다.

## CLI와 SDK

아래 명령은 사용 예시이며 이번 작업에서 실행하지 않았다. 전화번호는 예시 값이다. 실제 계정과 승인받은 테스트 상대, 파일로 대체해야 한다.

```bash
# 개발 실행은 아래 agent-kakaotalk 대신 bun src/platforms/kakaotalk/cli.ts 사용
agent-kakaotalk friend add-phone 01000000000 "테스트 상대" --country-iso KR --country-code 82 --account <account-id> --pretty
agent-kakaotalk friend list --account <account-id> --pretty
agent-kakaotalk chat open <user-id> --account <account-id> --pretty
agent-kakaotalk message upload <chat-id> ./01.pdf ./02.pdf ./03.pdf ./04.pdf ./05.pdf ./06.pdf ./07.pdf --as file --pretty
```

친구 추가 결과는 `user_id`, 방 열기 결과는 `chat_id`와 `existing`을 포함한다. `existing: true`는 목록과 구성원 확인으로 기존 방을 찾았다는 뜻이다. `false`는 SDK가 CREATE를 요청했다는 뜻이며 동시 외부 작업까지 포함한 서버 신규 생성 여부를 증명하지는 않는다. 같은 SDK 인스턴스에서 동시 요청은 하나로 합치고, 생성한 방을 snapshot에 반영해 다음 호출이 다시 CREATE하지 않도록 했다.

```typescript
import { readFile } from 'node:fs/promises'
import { KakaoTalkClient } from 'agent-messenger/kakaotalk'

// 호출자는 기존 계정 관리 흐름으로 인증된 client와 구체적인 발송 승인을 준비한다.
async function sendApprovedFiles(client: KakaoTalkClient) {
  const friend = await client.addFriendByPhone({ nickname: '테스트 상대', phoneNumber: '01000000000' })
  const room = await client.openDirectChat(friend.user_id)
  return client.sendFiles(room.chat_id, [
    { filename: '01.pdf', data: await readFile('./01.pdf') },
    { filename: '02.pdf', data: await readFile('./02.pdf') },
  ], { maxFileBytes: 10_000_000 })
}
```

SDK 예시는 호출 형태 설명이다. `10_000_000`은 예시 호출자 제한이며 서버 한도가 아니다.

batch 출력은 입력마다 `index`(0부터), `filename`, `size`, `status`, `log_id`, `sent_at`, `status_code`, `error`를 포함한다. 첫 실패에서 중단하며 이미 완료한 파일의 영수증은 유지한다. 상태는 `sent`, 명시적 서버 거절의 `failed`, 응답 유실 등의 `unknown`, 이후 미시도 파일의 `skipped`이다. 확인되지 않은 log ID는 `null`이다. CLI는 부분 실패 결과도 JSON으로 출력하고 종료 코드 1을 반환한다.

POST가 거절되면 파일 바이트를 보내지 않는다. COMPLETE가 없거나 실패했거나 유효한 log ID가 없으면 성공으로 처리하지 않는다. 친구 추가와 CREATE, 각 첨부의 쓰기는 자동 재전송하지 않는다. 이 SDK의 batch 결과는 영속 원장이 아니므로 프로세스 강제 종료 후 자동 복구는 워크벤치에서 구현해야 한다.

## 변경 파일

| 파일 | 변경 내용 |
| --- | --- |
| `src/platforms/kakaotalk/client.ts` | `getFriends`, `addFriendByPhone`, `openDirectChat`, `sendFiles`, 업로드 결과 검증 |
| `src/platforms/kakaotalk/friends.ts` | 공개 소스 기반 form/headers, 친구 목록 파싱과 전화번호 대조 |
| `src/platforms/kakaotalk/types.ts`, `index.ts` | 공개 타입, Zod schema, SDK export |
| `src/platforms/kakaotalk/cli.ts`, `commands/index.ts`, `commands/friend.ts` | 새 친구 CLI 등록 |
| `src/platforms/kakaotalk/commands/chat.ts`, `commands/message.ts` | `chat open`, 여러 문서 순차 업로드와 용량 검사 |
| `src/platforms/kakaotalk/protocol/session.ts`, `media-uploader.ts` | CREATE, POST 거절/연결 종료/offset/COMPLETE 처리 |
| `src/platforms/kakaotalk/new-dm-files.test.ts` | 친구, 1:1 방, 파일별 영수증, 순서와 중단, fake 업로드 통합 테스트 |
| `src/platforms/kakaotalk/commands/{friend,chat,message}.test.ts` | CLI 인자, 계정, JSON과 실패 종료 코드 |
| `src/platforms/kakaotalk/protocol/{session,media-uploader}.test.ts` | CREATE BSON과 fake 연결의 POST/바이트/COMPLETE 계약 |
| `src/platforms/kakaotalk/protocol/NOTICE.md`, `research/kakaotalk/` | 참조 출처, 고정 소스, 라이선스와 해시 |
| `docs/content/docs/{cli,sdk}/kakaotalk.mdx` | CLI와 SDK 사용법, 지원 범위와 제한 |
| `docs/kakaotalk-new-dm-files-261103.md`, `docs/kakaotalk-workbench-proposal-261103.md` | 조사 결과와 워크벤치 연결 제안 |

빌드 산출물은 이 worktree의 `dist/`에 생성되며 Git 추적 대상이 아니다. 다른 체크아웃의 node_modules를 링크하지 않고 이 worktree에서 lockfile 기준으로 의존성을 설치했다.

## 사람이 확인할 단계 (위험이 높은 순)

아래는 실행하지 않은 실계정 확인 절차다. 수신 상대와 최종 본문/첨부에 대한 사용자 승인을 받은 사람이 수행한다. 단계별 결과를 확인하고 다음 작업을 결정한다.

표는 위험이 높은 순서다. 실제 확인은 목록 조회, 연락처 추가, 방과 구성원 확인, 승인된 7개 파일 발송 순으로 진행한다.

| 위험도 | 확인 작업과 명령 | 확인할 내용 |
| --- | --- | --- |
| 가장 높음 | `agent-kakaotalk message upload <approved-test-chat-id> ./01.pdf ./02.pdf ./03.pdf ./04.pdf ./05.pdf ./06.pdf ./07.pdf --as file --pretty` | 통제된 테스트 상대에게 실제 7개 발송. 입력 순서, FILE(18), 서로 다른 log ID 7개, 다운로드 파일명과 내용. `unknown`이면 재실행 전에 이력 확인 |
| 높음 | `agent-kakaotalk friend add-phone <approved-phone> "<approved-name>" --account <account-id> --pretty` | 영구 연락처 변경. 상대의 전화번호 추가 허용, 상태 코드, 친구 목록에서 정확한 ID 대조. 실패 후 자동 재시도 금지 |
| 중간 | `agent-kakaotalk chat open <verified-user-id> --account <account-id> --pretty` | 방이 없을 때 새 1:1 방 ID 반환. 메시지 전송 없이 생성되는지, 구성원이 본인과 상대만인지 확인. 같은 명령 재호출은 동일 ID와 `existing: true` |
| 낮음 | `agent-kakaotalk friend list --account <account-id> --pretty`, `agent-kakaotalk chat list --all --account <account-id> --pretty`, `agent-kakaotalk member list <chat-id> --account <account-id> --pretty` | 현재 버전의 친구 phone 필드, PC/tablet API 호환성, 방 타입과 구성원. 목록 조회도 실제 인증과 서버 접속을 수반 |
| 낮음 | `agent-kakaotalk message list <chat-id> --account <account-id> --count 100 --pretty` | 발송 receipt의 log ID와 실제 파일 이력을 대조. 응답이 불명확할 때 재시도 전에 확인 |

호출자 용량 제한은 네트워크 없는 단위 테스트로 검증했다. 실제 서버 한도를 알아내기 위한 무작정 대용량 발송이나 반복 실패 시험은 수행하지 않았다. 앱에서 “7개 중 일부만 첨부”된 원인이 총 용량인지 파일별 제한인지도 확정할 수 없다.

## 구현하지 않은 것과 이유

- 카카오 서버의 현재 파일별/선택 묶음별 정확한 바이트 한도와 갤러리 최대 개수: 확인한 소스에 근거가 없고 실계정 시험이 금지되어 숫자를 만들지 않았다.
- 전화번호가 친구 목록에서 숨겨져 있거나 즉시 반영되지 않을 때의 ID 추측: 잘못된 상대에게 연결하지 않도록 `friend_added_id_unresolved`로 멈춘다. 반환 계약은 검증된 ID만 허용한다.
- 그룹/오픈채팅 생성, 친구 삭제/숨김, ID 기반 친구 추가, 대량 전화번호 업로드: 이번 요구 범위 밖이다.
- 자동 재시도, 실패 파일 전체 재전송, 영속 발송 원장: 응답 유실 후 중복 전송 위험이 있어 이 SDK 작업에 넣지 않았다.
- 워크벤치 공통 발송 코드와 overlay 반영: 요청대로 제안만 별도 문서에 작성했다.
- 실계정 동작 확인, commit, push, 배포: 요청한 금지 범위다.

## 검증 기록

전체 테스트는 `AGENT_MESSENGER_CONFIG_DIR`을 임시 경로로 지정해 실제 계정 설정을 사용하지 않았다. 새 테스트는 fake HTTP, fake 세션과 fake 업로드 연결만 사용하며 로그인이나 네트워크를 하지 않는다. E2E는 실행하지 않았다.

| 검증 | 최종 결과 |
| --- | --- |
| `bun install --frozen-lockfile --ignore-scripts` | 이 worktree에 265개 패키지 설치, lockfile 변경 없음, 다른 체크아웃 링크 없음 |
| `AGENT_MESSENGER_CONFIG_DIR=/tmp/kakao-offline-tests-261103 bun run test` | 4,208 pass, 0 fail, 285개 파일, 8,640 assertions |
| `bun run typecheck` | 통과 |
| `bun run build` | 통과. tsc, alias 변환, Node용 shebang과 vendored runtime 후처리 포함 |
| `bun run lint` | 오류 0, 기존 Teams 코드 경고 4개. Teams 파일은 수정하지 않음 |
| 변경 TypeScript 파일의 `oxfmt --check` | 통과 |
| `git diff --check` | 통과 |
| 고정 참조 소스 SHA-256 | 10개 파일 모두 manifest와 일치 |
| 빌드된 Node CLI의 `friend --help`, `chat open --help`, `message upload --help` | 통과. 도움말만 실행했고 계정이나 서버 접근 없음 |
| 빌드된 SDK import | 새 메서드 4개와 새 schema 4개의 export 확인 |

새 테스트는 이름만 같은 다른 친구, phone 비공개/중복, 큰 JSON 정수, 추가 후 ID 확인 실패, CREATE 거절/불완전 응답, 기존 방/동시 호출/반복 호출, 7개 FILE 파이프라인, 호출자 용량 초과 사전 중단, SHIP/POST/COMPLETE 거절, 응답 유실, 결과 일부 성공 및 CLI 실패 종료를 다룬다.
