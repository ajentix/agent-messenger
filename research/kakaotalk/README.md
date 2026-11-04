# KakaoTalk direct chats: protocol evidence

The reference snapshots under `node-kakao/` are unmodified public source files
from [storycraft/node-kakao](https://github.com/storycraft/node-kakao), commit
`8512e4699e2cd4c26516b80d38b57b2f85a6cc8a` (`stable` when inspected on
2026-11-03). The repository is MIT-licensed; its license and original notices
are retained. `.txt` is appended to each source filename so these references
are not compiled or linted as part of agent-messenger. `manifest.json` records
the original paths and SHA-256 hashes. They are not runtime dependencies.

| Behavior | Exact reference |
| --- | --- |
| Normal chat creation | `src/talk/channel/talk-channel-session.ts.txt`, `TalkChannelManageSession.createChannel`: `CREATE { memberIds: template.userList.map(user => user.userId) }`, optional `nickName` and `profileImageUrl` |
| Creation response | `src/packet/chat/create.ts.txt`: `chatId: Long`, optional `chatRoom` |
| Direct-chat discriminator | `src/channel/channel-type.ts.txt`: `DirectChat` |
| Known rejection statuses | `src/request/index.ts.txt`: provider status values, including creation restrictions. No byte-size or gallery-count limit is specified |

These sources establish request shapes. Opening a direct chat by user ID and
returning an existing room were verified with a real account on 2026-11-03.
Phone contact addition was excluded after real-account rejection with status
1101 (cause unknown); friend listing was not verified and is also excluded.
Their dedicated reference snapshots have been removed. See
`docs/kakaotalk-new-dm-files-261103.md` for the retained scope and verification
limits. No live requests were made during the subsequent cleanup.

The fork already implements single media uploads via
`src/platforms/kakaotalk/protocol/session.ts` and `media-uploader.ts`:
SHIP, POST, raw bytes and server COMPLETE. Multiple generic files use that same
flow sequentially. MSHIP/MPOST/FORWARD is retained for image galleries only.
Neither these sources nor the chat references establish a current
per-file size limit, aggregate selection size limit or maximum gallery count.
The desktop app's reported partial selection cannot be attributed to a
specific limit from this offline evidence.
