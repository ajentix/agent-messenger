# KakaoTalk phone contacts and direct chats: protocol evidence

The reference snapshots under `node-kakao/` are unmodified public source files
from [storycraft/node-kakao](https://github.com/storycraft/node-kakao), commit
`8512e4699e2cd4c26516b80d38b57b2f85a6cc8a` (`stable` when inspected on
2026-11-03). The repository is MIT-licensed; its license and original notices
are retained. `.txt` is appended to each source filename so these references
are not compiled or linted as part of agent-messenger. `manifest.json` records
the original paths and SHA-256 hashes. They are not runtime dependencies.

| Behavior | Exact reference |
| --- | --- |
| Phone contact addition | `src/api/service-api-client.ts.txt`, `addFriendWithPhoneNumber`: POST `{agent}/friends/add_by_phonenumber.json`, form `nickname`, `country_iso`, `country_code`, `phonenumber` |
| Phone-add response | `src/api/struct/friends/friend-req-struct.ts.txt`: `FriendReqPhoneNumberStruct` promises `pstn_number`, not a user ID |
| Friend list | `src/api/service-api-client.ts.txt`, `requestFriendList`: GET `{agent}/friends/list.json`, `type=["plus","normal"]`, `event_types=["create"]`, `token=0` |
| Friend IDs and phone fields | `src/api/struct/friends/friend-list-struct.ts.txt` and `friend-struct.ts.txt`: `friends`, `userId`, `phoneNumber`, `friendNickName`, `nickName`, `directChatId` |
| Service headers | `src/api/header-util.ts.txt`: `Authorization: accessToken-deviceUUID`, A and User-Agent headers. The current device identity comes from this fork's `protocol/config.ts` and matches its existing `getProfile` method |
| Form encoding | `src/api/web-api-util.ts.txt`: URLSearchParams |
| Normal chat creation | `src/talk/channel/talk-channel-session.ts.txt`, `TalkChannelManageSession.createChannel`: `CREATE { memberIds: template.userList.map(user => user.userId) }`, optional `nickName` and `profileImageUrl` |
| Creation response | `src/packet/chat/create.ts.txt`: `chatId: Long`, optional `chatRoom` |
| Direct-chat discriminator | `src/channel/channel-type.ts.txt`: `DirectChat` |
| Known rejection statuses | `src/request/index.ts.txt`: provider status values, including creation restrictions. No byte-size or gallery-count limit is specified |

These sources establish request shapes, not current server compatibility. The
stable code predates current KakaoTalk versions. No live Kakao server request,
account login, credential read, contact mutation, room creation or send was
performed during this implementation. Real-account verification is documented
in `docs/kakaotalk-new-dm-files-261103.md`.

The fork already implements single media uploads via
`src/platforms/kakaotalk/protocol/session.ts` and `media-uploader.ts`:
SHIP, POST, raw bytes and server COMPLETE. Multiple generic files use that same
flow sequentially. MSHIP/MPOST/FORWARD is retained for image galleries only.
Neither these sources nor the friend/chat references establish a current
per-file size limit, aggregate selection size limit or maximum gallery count.
The desktop app's reported partial selection cannot be attributed to a
specific limit from this offline evidence.
