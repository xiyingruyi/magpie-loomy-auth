# magpie-loomy-auth

为 [magpie](https://usemagpie.ai) 提供 provider `loomy`：登录 **Loomy（讯飞）**
账号，把它名下的模型接进来，并接入**每日首登赠送积分（每日赠送积分）**，
走 magpie 原生自动签到，积分自己到账。

[English](README.md) · **中文**

## 为什么需要这个插件

Loomy 客户端里没有「签到」按钮。每天 5000 积分来自一个很普通的接口
`POST /api/v1/points/first-login` —— 客户端在**当天第一次登录**时顺手按一下。
所以只转发对话的插件等于把这些积分留在桌上。这个插件替你把这一下按掉：
每个北京自然日一次，结果直接显示在 provider 卡片上。

这是 [`lin2670/magpie-plugins`](https://github.com/lin2670/magpie-plugins) 里
Loomy 部分的**从头重写**（只要讯飞这一块），并且把之前做
`magpie-lobster-auth` 时踩到的坑从一开始就设计掉（见「设计要点」）。

## 安装

provider 的头像就是仓库里的 `icon.svg`。`package.json` 里写了两份，因为
magpie 的两个列表读的不是同一个字段：`magpie.icon` 是内联 data URI，给
provider 卡片用（立即保存、不联网）；`magpie.iconUrl` 是 GitHub 的 raw 地址，
给插件列表用（宿主在后台下载，下一次刷新显示）。

没有发布到 npm；magpie 可以直接从 GitHub 装：

```sh
magpie plugin add github:xiyingruyi/magpie-loomy-auth
magpie plugin login loomy
```

也可以先 clone 下来再装这个文件夹（想先读代码的话）：

```sh
git clone https://github.com/xiyingruyi/magpie-loomy-auth.git
magpie plugin add ./magpie-loomy-auth
magpie plugin login loomy
```

装完后记得在 provider 卡片上打开「自动签到」—— 第三方插件默认是关的。

### 更新 / 停用 / 卸载

```sh
magpie plugin update            # 把每个 github: 插件拉到最新
magpie plugin on|off <name>     # 临时关掉，不删除
magpie plugin rm <name>         # 删掉
magpie plugin logout loomy      # 忘掉已保存的登录态
```

`<name>` 取 `magpie plugin list` 里显示的那个。用路径装的插件是**实时读那个
文件夹**的，所以更新就是在文件夹里 `git pull`。

## 登录

两种方式，任选其一。

- **手机验证码。** 输入 11 位中国大陆手机号，插件按 Loomy 桌面客户端的方式
  签名发码，再让你输入 6 位验证码。拿到的是 **14 天有效的 session**。Loomy
  没有续期接口，到期只能重新登录 —— 插件不会假装还有别的办法。
- **手动粘贴 session。** 已经有客户端的 `token` 值就直接粘进来。插件会**先用
  `/api/v1/models` 验证一次**，所以粘错一个字符不会变成一个「显示已登录、每次
  请求都 401」的账号。

## 请求

对话走 `https://loomyad.xunfei.cn/api/v1/chat/completions`，OpenAI 形状，
SSE 流式。

- **两个鉴权头都发**（`token:` 与 `Authorization: Bearer`）—— Loomy 的模型/
  积分网关与对话网关读的不是同一个。
- **`Content-Type` 带 `charset=utf-8`。** 没有它上游按 GBK 解 body，中文会
  变成乱码。
- **思考档位折进上游认识的三个。** `minimal`/`low` → `low`，`medium` →
  `medium`，`high`/`xhigh`/`max`/`ultra` → `high`；`none`/`off`/不认识的值
  上游没有对应档，**删掉**而不是发过去。
- **DeepSeek 系模型收「标记式图片」。** Loomy 的 DeepSeek 模型把 data URI
  图片读成文本里的 `<image_base64>data:…</image_base64>`，不是 `image_url`
  块；插件负责转换与合并。`http(s)` 图片 URL 保持原样。
- **非流式调用方拿到真正的 `chat.completion`。** 如果 agent 用
  `stream: false` 请求而上游仍以 SSE 作答，插件会把分片重组回来 ——
  `content`、`reasoning_content`、`tool_calls` 都在。

### 错误

Loomy 对**本该是错误**的情况回 **HTTP 200 + 业务码**，登录失效也一样
（`code 100002`，`desc: 登录已失效，请重新登录`）。原样透传会看起来像一次
成功的回复，账号的失效标记也永远打不上。插件读业务码，还原成它真正表示的
状态：

| 上游 | HTTP | magpie 的处置 |
|---|---|---|
| `100002` / `020002`（登录失效 / 缺 token） | 401 + `X-Magpie-Sign-In: expired` | 标记账号、提示重新登录 |
| `40201` / `40200` / 额度用完措辞 | 402 `insufficient_quota` | 停下，不重试 |
| `40300` / `40301`（模型不提供） | 403 | 模型维度的拒绝 |
| `42900` / `42901` / 限流措辞 | 429 | 等待后重试 |
| `40100` / `51102` | 401 + `X-Magpie-Sign-In: expired` | 标记账号 |
| 其它没见过的码 | 400 | 请求本身有问题 |

所有失败都以 `Response` 返回，绝不抛异常 —— 插件的 fetch 抛错只会让 magpie
记一条没有上下文的失败。

## 模型

登录后清单来自账号自己（`GET /api/v1/models`）：OpenAI 条目，外加
`capabilities { reasoning, vision, function_calling, streaming, input_modalities,
output_modalities }`、`context_length`、`max_output_tokens`，以及
`reasoning_efforts`（`none`/`low`/`medium`/`high`/`xhigh`，成为 magpie 的
variants）。展示名尾部带倍率（`Spark X2.5 (x0.1)`），成为 magpie 的 `rate`。

**输出上限绝不自己编。** 上游给了 `max_output_tokens` 就用它；没给就是 `0` ——
magpie 把它读成「上游没说」，转而从 models.dev 取值。这一点很关键：magpie 把
模型的 `limit.output` 当作**硬上限**下发到每个请求，自己编一个「保守」的默认值，
就等于造出一个真实的天花板（之前 384,000 token 的回复被夹到 32,000，就是这么
来的）。

生图条目（`type: "image"`、输出只有 image）不进清单：它们唯一的门是
`/api/v1/images/generations`，而 magpie 不替插件账号转发那个接口 —— 列出来就是
提供一个选了必然失败的模型。

登录之前用一份 3 个模型的兜底表，让 provider 在登录前就可见。清单按账号缓存
几分钟：magpie 在**每个**转发的请求前都会问一次插件的模型清单，每次都去问上游
等于给每一句对话都加一次往返。

## 积分与用量

`magpie quota` 显示两个窗口，数据来自 `/api/v1/points/records`（v2 是同一份
数据的另一个入口）：

- **每日赠送积分** —— 今日已用 / 每日额度（`327 / 5,000 credits · 7% used`），
  北京零点重置；
- **永久积分** —— 永久钱包，不过期（`aside`）。

每日额度不在这个接口里（上游只回还剩多少），来自签到接口的 `dailyQuota`，
签到成功时记到账号上；没签到过的账号用出厂值 5000。

这个接口实测 0.3s–28s 抖动，偶尔回业务码 `900000`（「系统内部错误」，HTTP 仍
是 200）。而 **magpie 给插件 usage 钩子的期限只有 20 秒**
（`plugin_usage.go` 的 `context.WithTimeout`），超了就由宿主放弃、卡片上打
「截至 X，暂时无法获取最新额度」—— 那与积分是否充足无关。所以插件的读取预算
压在 20 秒以内，并分两段：8 秒问 v2，不成再用 8 秒问 v1。两个入口都失败才退回
上一次成功的结果并注明「显示的是上一次读取的结果」。

登录失效要**两个入口都说**才算数：实测上游偶尔对一次只读请求回 `100002`，而
session 本身是好的。拿一次这种回答去标记账号，用户得重新短信登录才消掉。

干净读取时**不报 `signIn`**：这是 magpie 清除瞬时 401 留下的失效标记的方式。
Loomy 无法续期，这里报 `kept` 会让那个标记永远留在账号上。

## 每日签到

插件实现了 magpie 的 `auth.checkin` 钩子，因此 provider 卡片上自动出现
「立即签到」按钮和「自动签到」开关。它按的是
`POST /api/v1/points/first-login` —— 和 Loomy 客户端当天首次登录时按的是同一个
请求。

- **自动签到默认关闭，需要你打开。** 打开后由 magpie 自己排期：每个北京自然日
  一次，失败后 30 分钟重试。
- **绝不虚报领到多少。** 响应里的 `dailyBalance` 是**刷新后的余额**，不是本次
  发放量 —— 所以它只出现在消息里，绝不作为 `credit` 上报。
- **钩子永不抛错。** 连 `getAuth` 失败也会折成 `outcome`，magpie 因此能留下
  原因，而不是记一条空失败。
- **死账号报 `ineligible`，不是 `failed`。** 每 30 分钟重试一个已失效的账号
  帮不了任何人；magpie 得到的是明确的「请重新登录」。

### 一次性新手任务（默认关闭）

Loomy 还有 8 个一次性任务（合计 10000 积分）。它们是**福利，不是每日任务**，
所以不放进每日循环。provider 上的开关「补领一次性新手任务」**默认关闭**；
打开后，下一次签到会补领尚未领取的项目一次。全部领完即结算
（`onboardingSettled`），之后再也不会扫描。单个 key 失败不会结算，下一轮重试。

## 不做的事

- **续期。** Loomy 没有这个接口，session 14 天。
- **从 agent2api 导入。** 参照实现提供了从
  [aimod-cc/agent2api](https://github.com/aimod-cc/agent2api) 本地数据库导入
  登录态的方式。那会把插件绑死在另一个工具的私有表结构上，换来的只是短信
  登录本来就能做的事，因此不做。
- **企业 / SSO 账号。** 只处理手机号登录。
- **同时多个账号。** magpie 每个 provider 槽位只保留一份登录。

## 设计要点

五个真实发生过的故障，在这里都被设计掉，并且各有一条回归测试：

1. **自己编的输出上限**会悄悄夹住每个回复 —— `limit.output` 是硬上限，不是
   元数据。不声明即 `0`，即「去问 models.dev」。
2. **藏在 HTTP 200 里的错误**永远不会被归类。Loomy 对登录失效正是这么做的；
   插件按业务码还原。
3. **拿死 token 去签到**看起来完全像「今天还没签」。首登接口按天幂等，不会
   重复领取，但插件仍报 `ineligible`，让账号被标记而不是被无限重试。
4. **会抛错的签到钩子**会丢掉 message。所有路径都返回 outcome。
5. **登录方法直接 return 结果、而不是交回 callback。** magpie 对每个 oauth
   流程都会调一次 `callback`，而 `authorize` 的返回值里只留下
   `{url, instructions, method}`；直接作答的方法会死在
   `s.a.callback is not a function`，连失败原因都看不见。这里**每一条**路径
   （包括每一条失败路径）都交回带 callback 的流程，有一条测试把六种输入全走
   一遍。

## 真实上游教给我们的东西

拿两个真实账号跑下来，发现了一批参照实现猜错的地方。每一条现在都有测试钉住：

- **模型清单的字段名。** 真实清单用的是 `context_length` / `max_output_tokens`，
  参照实现读的是 `context_window` / `max_tokens`。只认旧名字会让每个模型的输出
  上限都变成 `0`。
- **积分接口根本不带额度字段。** `GET /api/v1/points/records` 只回 `balance`、
  `dailyBalance`、`availableBalance`，没有参照实现读的 `dailyLimitPoints`。
  拿余额当上限会显示成「0 / 4,673 · 0% used」。真实的每日额度（5000）只出现在
  `POST /api/v1/points/first-login` 的 `dailyQuota` 里，所以签到会把它记到账号
  上，用量页从那里读。
- **`auto` 是会调工具的。** 它的目录条目连 `capabilities` 都没有。把「没说」
  当成「不支持」，会让自动模型用不了工具 —— 而它路由到的模型是支持的。
- **生图模型不是聊天模型。** 三个（`Hy-Image-3.5-preview`、
  `doubao-seedream-5-lite`、`qwen-image-3.0-pro`）在对话端点一律回 404
  「该模型暂未开放」，唯一的门是 `/api/v1/images/generations`，而 magpie 不替
  插件账号转发这个接口。所以它们不进清单，而不是列出来必然失败。
- **积分接口很慢。** 实测 0.3s–28s，偶尔回业务码 `900000`（「系统内部错误」）。
  更关键的是 **magpie 只给 usage 钩子 20 秒**：插件原来给 45 秒，宿主先放弃，
  卡片上就成了「暂时无法获取最新额度」—— 明明积分充足。现在预算压进 20 秒，
  并换入口重试一次。

## 开发

```sh
bun test                    # 111 个测试，全部打在本地 fake 上游
bun scripts/live-check.mjs  # 对真实服务的只读检查
LOOMY_SESSION=… bun scripts/live-check.mjs   # 再加模型、积分与一次真实对话
```

fake 上游（`test/fake.mjs`）会**重新计算账号域的 HMAC 签名**再比对，并检查
对话请求的双鉴权头与 charset —— 签名代码一旦写错，测试就会失败，而不是让真实
服务去发现。

自审中修掉的两个缺陷也各有一条回归测试：首条 SSE 记录之后正好切在多字节字符
中间时，尾部字节会被丢掉（`peekFirst` 改成按字节切分）；首条就是错误时，上游
响应体没有被取消（连接要等 GC 才还回去）。

入口只负责装配钩子；逻辑都在 `lib/` 下是普通函数，测试经由 `_internal` 取用 ——
因为 magpie 和 OpenCode 都会把每一个导出的函数当成一个独立插件。

环境变量（仅供测试 / 镜像，与参照实现同名）：

| 变量 | 默认 |
|---|---|
| `LOOMY_POINTS_BASE_URL` | `https://loomyad.xunfei.cn` |
| `LOOMY_XFYUN_BASE_URL` | `https://account.xfinfr.com` |
| `LOOMY_XFYUN_ACCESS_KEY_ID` / `_SECRET` | 客户端内置的一对常量 |
| `LOOMY_XFYUN_APP_ID` | `GM3LOOMY` |

## 致谢

请求形态（HMAC 信封、端点、请求体适配）移植自
[aimod-cc/agent2api](https://github.com/aimod-cc/agent2api)（MIT）与
[`lin2670/magpie-plugins`](https://github.com/lin2670/magpie-plugins)（MIT）。
两处上游的版权声明都抄录在 [NOTICE](NOTICE) 里。

## 许可

MIT —— 见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
