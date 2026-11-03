# Third-Party Notices

This KakaoTalk protocol and Android authentication implementation was written
from scratch for agent-messenger. The protocol knowledge used to build it comes
from the following open-source projects and their documentation. No code was
copied into the runtime from these projects. Unmodified, attributed reference
snapshots for the phone-contact and CREATE work are retained separately under
`research/kakaotalk/node-kakao/`.

---

## openkakao

- Repository: https://github.com/JungHoonGhae/openkakao
- License: MIT
- Copyright (c) 2025 JungHoonGhae

Primary protocol reference for: current encryption parameters (AES-128-GCM,
key_encrypt_type=16, encrypt_type=3), RSA public key (PKCS#1, e=3), connection
flow (Booking → Checkin → Login), packet structure, LOCO command reference,
macOS credential extraction approach, and LOGINLIST field schema.

---

## loco-wrapper

- Repository: https://github.com/NetRiceCake/loco-wrapper
- License: No license specified
- Note: Referenced for protocol behavior only; no code adapted.

Referenced for: LOGINLIST packet field names and BSON types (LoginListOut.java),
Android sub-device login flow, and connection patterns.

---

## node-kakao

- Repository: https://github.com/storycraft/node-kakao
- License: MIT
- Copyright (c) 2020 storycraft

Referenced for: LOCO packet format, BSON command schemas, authentication flow,
Android OAuth refresh request/response behavior, X-VC signature algorithm,
channel/chat type enumerations.

Phone contacts, friend listing and normal chat creation additionally reference
commit `8512e4699e2cd4c26516b80d38b57b2f85a6cc8a`:
`src/api/service-api-client.ts`, `src/api/header-util.ts`, the friend structs,
and `src/talk/channel/talk-channel-session.ts` (CREATE with memberIds).
Unmodified source snapshots, SHA-256 hashes and the MIT license are retained
under `research/kakaotalk/node-kakao/`. They are reference material, not runtime
dependencies. The phone-add response only promises `pstn_number`; this SDK
resolves the user ID from the friend list by exact normalized phone number.

---

## KakaoForge

- Repository: https://github.com/play2fly/KakaoForge
- Reference commit: 4b774ea40b1347280fadb685415436584093118b
- License: KakaoForge Non-Commercial / No Abuse License
- Copyright (c) 2026 aodjo

Referenced for: current Android `oauth2_token.json` request fields, client
headers, device-id handling, and token rotation/expiry response fields. Protocol
behavior only; no source code was copied or adapted.

---

## Original LOCO Protocol Research

- Author: Cai (bpak.org)
- URL: http://www.bpak.org/blog/tag/loco/
- Date: 2012-2013

The foundational reverse engineering of the LOCO protocol that all subsequent
implementations are based on.
