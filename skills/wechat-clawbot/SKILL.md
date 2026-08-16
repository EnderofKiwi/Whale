---
name: wechat-clawbot
description: Operate and troubleshoot the Whale WeChat channel — Tencent's official iLink Bot API (微信 ClawBot), including the one-time QR login, the long-poll receive loop, and the context_token reply rule.
whenToUse: When the user asks about the WeChat channel, ClawBot, scanning to log in, or debugging inbound/outbound WeChat messages in this Whale deployment.
---

# WeChat ClawBot channel (iLink Bot API)

Whale connects WeChat through Tencent's official personal-WeChat bot API,
the same "iLink" protocol used by Marvis and WorkBuddy. The server is
`https://ilinkai.weixin.qq.com` — there is no local endpoint to configure.

## One-time QR login ("扫码即可")

On `whale serve` (or when the WeChat channel starts without a saved token):

1. Whale calls `GET /ilink/bot/get_bot_qrcode?bot_type=3` and prints a login
   link (`https://liteapp.weixin.qq.com/q/…?qrcode=…&bot_type=3`).
2. Copy that link and open it in WeChat on your phone (e.g. send it to
   yourself via 文件传输助手 and tap it) — this confirms the login.
3. Whale polls `GET /ilink/bot/get_qrcode_status?qrcode=…` until `confirmed`,
   then persists `bot_token` + `baseurl` to `$DSH_HOME/whale-wechat-token.json`.

After that the token is reused; re-scan only when it expires.

## Message flow

- **Typing indicator**: on each inbound message, Whale calls `getconfig`
  (caches `typing_ticket` per user, 24 h), then `sendtyping {status:1}` to show
  "对方正在输入…", and after `sendmessage` it sends `sendtyping {status:2}` to
  clear it.
- **Receive**: `POST /ilink/bot/getupdates` long-polls up to 35 s, returning
  `msgs[]` and a `get_updates_buf` cursor that must be echoed back.
- **Reply**: `POST /ilink/bot/sendmessage` sends
  `{ msg: { to_user_id, message_type: 2, message_state: 2, context_token,
  item_list: [{ type: 1, text_item: { text } }] } }`.
  The inbound message's `context_token` MUST be carried, or the reply will not
  land in the right chat.

## Slash commands

- `/new` (aliases `/reset`, `/clear`, `/新会话`, `/重置`) — start a fresh
  conversation for the sender: the cached agent is dropped and the next message
  gets a brand-new session instead of resuming the old one. The reset is
  in-memory, so it does not survive a `whale serve` restart (the previous
  session resumes from disk).

## Auth headers (every request after login)

```
Content-Type: application/json
AuthorizationType: ilink_bot_token
X-WECHAT-UIN: base64(decimal(random uint32))   # changes each request
Authorization: Bearer <bot_token>
```

## Environment / config

- `WHALE_WECHAT_BOT_TOKEN` — pre-supply a token instead of QR login.
- `WHALE_WECHAT_TOKEN_FILE` — where the token persists (default `$DSH_HOME/whale-wechat-token.json`).
- `WHALE_WECHAT_BASE_URL` — override the API base (default `https://ilinkai.weixin.qq.com`).
- `WHALE_WECHAT_CDN_BASE_URL` — override the media CDN base (default `https://novac2c.cdn.weixin.qq.com/c2c`).
- `WHALE_WECHAT_MODEL` — model for WeChat replies (default `deepseek-v4-flash` for snappier chat).

## Inbound media (image / voice / file / video)

Inbound messages arrive as `item_list[]`; `item.type` is `1` text, `2` image,
`3` voice, `4` file, `5` video. Media items carry a `media` object with
`encrypt_query_param` (the CDN download token, or `full_url`) and `aes_key`.
Whale downloads the ciphertext from the CDN, AES-128-ECB-decrypts it (the key is
base64 of raw 16 bytes for images, or of the 32-char hex for file/voice/video),
and saves the plaintext under `$DSH_HOME/wechat-media/`. The agent sees the
absolute path in the message text and reads it with its file tools.

- Images need a vision-capable model to be "seen"; the default WeChat model
  (`deepseek-v4-flash`) is text-only, so images are saved but not visually read
  unless you switch to a vision model.

## Notes / limits

- Tencent is a "pipe" only: it relays messages but does not provide the AI.
- Tencent may rate-limit or block specific AI services; keep a fallback channel.
