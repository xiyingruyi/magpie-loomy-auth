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

The provider's icon is `icon.svg`. `package.json` carries it twice, because
magpie's two lists read different fields: `magpie.icon` as an inline data URI
for the provider card (stored at once, no network), and `magpie.iconUrl` as a
raw GitHub URL for the plugin list, which fetches pictures in the background.

Not published to npm; magpie installs it straight from GitHub:

```sh
magpie plugin add github:xiyingruyi/magpie-loomy-auth
magpie plugin login loomy
```

Or clone it and add the folder, if you would rather read the code first:

```sh
git clone https://github.com/xiyingruyi/magpie-loomy-auth.git
magpie plugin add ./magpie-loomy-auth
magpie plugin login loomy
```

Then turn on **Auto check-in** on the provider card — third-party plugins
default to off.

### Updating, disabling, removing

```sh
magpie plugin update            # pulls the newest version of every github: plugin
magpie plugin on|off <name>     # turn it off without removing it
magpie plugin rm <name>         # remove it
magpie plugin logout loomy      # forget the stored session
```

`<name>` is what `magpie plugin list` shows. A plugin added by path is read live
from that folder, so a `git pull` inside it is the update.

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
| `40201` / `40200` / quota wording | 402 `insufficient_quota` | stops instead of retrying |
| `40300` / `40301` (model not served) | 403 | model-level refusal |
| `42900` / `42901` / rate-limit wording | 429 | backs off |
| `40100` / `51102` | 401 + `X-Magpie-Sign-In: expired` | the account is marked |
| any other unrecognised code | 400 | a bad request |

Every failure is a `Response`, never a thrown error: a throw from a plugin's
fetch leaves magpie with a failure that has no context.

## Models

Signed in, the list is the account's own (`GET /api/v1/models`): OpenAI-shaped
entries plus `capabilities { reasoning, vision, function_calling, streaming,
input_modalities, output_modalities }`, `context_length`, `max_output_tokens`,
and `reasoning_efforts` (`none`/`low`/`medium`/`high`/`xhigh`, exposed as magpie
variants). Display names carry the credit rate (`Spark X2.5 (x0.1)`), which
becomes magpie's `rate`.

**The output limit is never invented.** An entry that says
`max_output_tokens` gets that number; one that doesn't gets `0`, which magpie
reads as "not said" and fills from models.dev. That matters because magpie
enforces a model's `limit.output` as a **hard cap** on every request: a "safe"
made-up default becomes a real ceiling (this is exactly how 384,000-token
replies were once clamped to 32,000).

Image-generation entries (`type: "image"`, output `image` only) are left out:
their only door is `/api/v1/images/generations`, which magpie does not route
for plugin accounts, so listing them would mean offering a model that always
fails.

Before signing in, a three-model fallback keeps the provider visible. The
catalogue is cached per account for a few minutes: magpie asks the plugin for
its model list before **every** request it proxies, so answering from the
vendor each time would add an upstream round trip to every chat.

## Points and usage

`magpie quota` shows two windows, from `/api/v2/points/records`:

- **每日赠送积分** — used today against the daily quota
  (`327 / 5,000 credits · 7% used`), resetting at Beijing midnight;
- **永久积分** — the permanent wallet, which never expires (`aside`).

The daily quota itself is not in that response (the vendor only says how much
is left). It comes from the check-in endpoint's `dailyQuota` and is recorded on
the account when check-in runs; an account that never checked in falls back to
a factory 5000.

That endpoint measured 2.4s–20s+ with occasional "系统内部错误" answers, so reads
get a 45s budget and fall back to the last good reading, marked as such, rather
than turning the card into an error.

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

Five failure modes are designed out here, each with a regression test:

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
5. **A sign-in that returns its result instead of a callback.** Magpie always
   calls a flow's `callback` and keeps only `{url, instructions, method}` from
   `authorize`, so a method that answers directly dies on
   `s.a.callback is not a function` and hides the reason it failed. Every path
   here — including every failure path — hands back a flow with a callback.
   A test walks all six of them.

Plus two defects an adversarial review pass found in the streaming path, both
with regression tests of their own: a multi-byte character split just after
the first SSE record used to lose its trailing bytes (`peekFirst` now slices
bytes, not a decoded string), and a first-frame error abandoned the upstream
body instead of cancelling it.

### What the live service taught us

Running the plugin against two real accounts turned up fields and behaviours
the reference implementation had guessed wrong. Each one is now pinned by a
test:

- **The catalogue's field names.** The live list uses `context_length` /
  `max_output_tokens`; the reference reads `context_window` / `max_tokens`.
  Reading only the old names made every model's output limit `0`.
- **The usage endpoint has no quota field.** `GET /api/v2/points/records`
  returns `balance`, `dailyBalance` and `availableBalance` — not the
  `dailyLimitPoints` the reference reads. Using the balance as the limit
  printed `0 / 4,673 · 0% used`. The real daily quota (`5000`) only appears in
  `POST /api/v1/points/first-login`'s `dailyQuota`, so check-in records it on
  the account and the usage page reads it from there.
- **`auto` does call tools.** Its catalogue entry has no `capabilities` at
  all. Treating "said nothing" as "not supported" left the automatic model
  unable to use tools, though it routes to one that can.
- **Image models are not chat models.** All three (`Hy-Image-3.5-preview`,
  `doubao-seedream-5-lite`, `qwen-image-3.0-pro`) answer the chat endpoint with
  404 "该模型暂未开放"; their only door is `/api/v1/images/generations`, which
  magpie does not route for plugin accounts. They are left out of the list
  rather than offered and failing.
- **The points endpoint is slow.** Measured between 2.4s and 20s+, sometimes
  answering with business code `900000` ("系统内部错误"). Usage reads get a
  45s budget and fall back to the last good reading — marked as such — instead
  of turning the card into an error.

## Development

```sh
bun test                    # 106 tests, all against a local fake upstream
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
