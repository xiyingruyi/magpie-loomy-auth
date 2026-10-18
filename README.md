# magpie-loomy-auth

A [magpie](https://usemagpie.ai) provider plugin for **Loomy (讯飞 / iFlytek)**:
signs in with a phone number, serves Loomy's OpenAI-compatible model gateway as
the provider `loomy`, reports both point wallets, and claims the **daily
first-login grant (每日首登赠送)** through magpie's native automatic check-in.

**English** · [中文](README.zh-CN.md)

## Why this plugin exists

Loomy's client does not have a "check-in" button. The daily 5000 points come
from a plain endpoint — `POST /api/v1/points/first-login` — that the desktop
client presses as part of its **first login of the day**. So a plugin that
just forwards chats leaves those points on the table. This one presses it for
you, once per Beijing day, and reports the result on the provider card.

It is a from-scratch implementation of the Loomy provider in
[`lin2670/magpie-plugins`](https://github.com/lin2670/magpie-plugins) — only
the iFlytek piece — with the failure modes found while shipping
`magpie-lobster-auth` designed out from the start (see **Design notes**).

## Install

A folder plugin, not published to npm:

```sh
git clone https://github.com/xiyingruyi/magpie-loomy-auth.git
magpie plugin add ./magpie-loomy-auth
magpie plugin login loomy
```

Then turn on **Auto check-in** on the provider card — third-party plugins
default to off.

## Signing in

Two ways, either is enough.

- **SMS (手机验证码).** Type an 11-digit mainland phone number; the plugin
  sends the code (signed the way Loomy's desktop client signs it) and asks you
  for the 6 digits. The result is a **14-day session**. Loomy has no renewal
  endpoint, so when it ends you sign in again — the plugin never pretends
  otherwise.
- **Paste a session.** If you already have the `token` value from the client,
  paste it. The plugin **verifies it against `/api/v1/models` first**, so a
  typo cannot end up as an account that "signed in" but 401s on every request.

## Requests

Chats go to `https://loomyad.xunfei.cn/api/v1/chat/completions`, OpenAI-shaped
and streamed as SSE.

- **Both auth headers are sent** (`token:` and `Authorization: Bearer`): the
  model and chat gateways in Loomy read different ones.
- **`Content-Type` carries `charset=utf-8`.** Without it the upstream decodes
  the body as GBK and CJK text arrives corrupted.
- **Thinking levels fold into the three the upstream knows.** `minimal`/`low`
  → `low`, `medium` → `medium`, `high`/`xhigh`/`max`/`ultra` → `high`;
  `none`/`off`/unknown values have no upstream equivalent and are **removed**
  rather than sent.
- **DeepSeek models get images as markers.** Loomy's DeepSeek models read a
  data-URI image as `<image_base64>data:…</image_base64>` inside the text, not
  as an `image_url` part; the plugin converts and merges it. `http(s)` image
  URLs are left alone.
- **Non-streaming callers get a real `chat.completion`.** If an agent asks with
  `stream: false` but the upstream answers with SSE anyway, the chunks are
  reassembled — content, `reasoning_content` and `tool_calls` included.

### Failures

Loomy answers **HTTP 200 with a business code** for things that are really
errors — including an expired session (`code 100002`, `desc: 登录已失效，请重新登录`).
Passing that through would look like a successful reply and the account's
lapse would never be recorded. The plugin reads the code and answers what it
means:

| upstream | HTTP | effect in magpie |
|---|---|---|
| `100002` / `020002` (session gone, missing token) | 401 + `X-Magpie-Sign-In: expired` | the account is marked, a re-sign-in is offered |
| `40201` / quota wording | 402 `insufficient_quota` | stops instead of retrying |
| `40300` / `40301` (model not served) | 403 | model-level refusal |
| `42900` / rate-limit wording | 429 | backs off |
| anything else | 400 | a bad request |

Every failure is a `Response`, never a thrown error: a throw from a plugin's
fetch leaves magpie with a failure that has no context.

## Models

Signed in, the list is the account's own (`GET /api/v1/models`): OpenAI-shaped
entries plus `capabilities { reasoning, function_calling, vision }`, a context
window, and — sometimes — a `max_tokens`. Display names carry the credit rate
(`Spark X2.5 (x0.1)`), which becomes magpie's `rate`.

**The output limit is never invented.** An entry that says `max_tokens` gets
that number; one that doesn't gets `0`, which magpie reads as "not said" and
fills from models.dev. That matters because magpie enforces a model's
`limit.output` as a **hard cap** on every request: a "safe" made-up default
becomes a real ceiling (this is exactly how 384,000-token replies were once
clamped to 32,000).

Before signing in, a three-model fallback keeps the provider visible.

## Points and usage

`magpie quota` shows two windows, from `/api/v2/points/records`:

- **每日赠送积分** — today's daily grant, resetting at Beijing midnight;
- **永久积分** — the permanent wallet, which never expires (`aside`).

A clean read reports **no `signIn`**: that is how magpie clears a lapse mark
left by a transient 401. Loomy cannot renew a session, so claiming "kept" here
would leave that mark on forever.

## Daily check-in

The plugin implements magpie's `auth.checkin` hook, so the provider card gets
「立即签到 / Check in now」 and 「自动签到 / Auto check-in」. It presses
`POST /api/v1/points/first-login`, which is the same request Loomy's client
makes on the day's first login.

- **Automatic check-in is OFF until you turn it on.** Magpie schedules it
  itself: once per Beijing day, retrying 30 minutes after a failure.
- **It never claims a reward it did not get.** `dailyBalance` in the answer is
  the **balance after** the refresh, not an amount granted — so it is shown in
  the message and never reported as `credit`.
- **The hook never throws.** Even a failing `getAuth` becomes an `outcome`, so
  magpie keeps the reason instead of recording a bare failure.
- **A dead session is `ineligible`, not `failed`.** Retrying a lapsed account
  every 30 minutes helps nobody; magpie gets a clear "sign in again" instead.

### One-time newbie tasks (off by default)

Loomy also has eight one-time tasks (10,000 points in total). They are **welfare,
not a daily task**, so they are not part of the daily loop. A provider switch —
**「补领一次性新手任务」**, default off — makes the next check-in report the
unclaimed ones once. When every key is done the account is settled
(`onboardingSettled`) and the scan never runs again. A single key failing does
not settle the account: it is retried on the next check-in.

## Not here

- **Session renewal.** Loomy has none. Sessions last 14 days.
- **The agent2api import.** The reference plugin offers to import a sign-in
  from [aimod-cc/agent2api](https://github.com/aimod-cc/agent2api)'s local
  database. That couples the plugin to another tool's private schema for a
  convenience SMS login already covers, so this plugin leaves it out.
- **Company / SSO accounts.** Only phone sign-in is handled.
- **Several accounts at once.** magpie keeps one sign-in per provider slot.

## Design notes

Four failure modes from an earlier magpie provider plugin are designed out
here, each with a regression test:

1. **A made-up output limit** silently caps every reply — `limit.output` is a
   hard cap, not metadata. Omitted means `0`, which means "ask models.dev".
2. **Errors hidden inside HTTP 200** would never be classified. Loomy does
   exactly this for a lapsed session; the plugin maps the business code.
3. **A dead token spent on a check-in** looks identical to "not checked in
   yet". The daily grant is idempotent so this cannot double-claim, but the
   plugin still reports `ineligible` so the account is marked instead of
   retried forever.
4. **A check-in hook that throws** loses its message. Every path returns an
   outcome.

## Development

```sh
bun test                    # 76 tests, all against a local fake upstream
bun scripts/live-check.mjs  # read-only checks against the real service
LOOMY_SESSION=… bun scripts/live-check.mjs   # + models, usage, one chat
```

The fake upstream (`test/fake.mjs`) **re-computes the account domain's HMAC
signature** for every request and checks both auth headers and the charset on
chat, so a regression in the signing code fails the suite rather than the
live service.

Two defects found by review have regression tests of their own: a multi-byte
character split right after the first SSE record used to lose its trailing
bytes (`peekFirst` now slices bytes, not a decoded string), and a first-frame
error used to abandon the upstream body instead of cancelling it.

The entry point only assembles hooks. The logic lives in `lib/` as plain
functions, reached through `_internal` in tests, because magpie and OpenCode
treat every exported function as a plugin of its own.

Environment variables (test/mirror only, same names as the reference
implementation):

| variable | default |
|---|---|
| `LOOMY_POINTS_BASE_URL` | `https://loomyad.xunfei.cn` |
| `LOOMY_XFYUN_BASE_URL` | `https://account.xfinfr.com` |
| `LOOMY_XFYUN_ACCESS_KEY_ID` / `_SECRET` | the client's built-in pair |
| `LOOMY_XFYUN_APP_ID` | `GM3LOOMY` |

## Credits

The request shapes (HMAC envelope, endpoints, body adaptations) are ported
from [aimod-cc/agent2api](https://github.com/aimod-cc/agent2api) (MIT) and
[`lin2670/magpie-plugins`](https://github.com/lin2670/magpie-plugins) (MIT).
Both upstream copyright notices are reproduced in [NOTICE](NOTICE).

## License

MIT — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
