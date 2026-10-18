# dsh-plugins

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的一套插件，作为**一个 bundle** 提供。

[English version](README.en.md)

| 插件 | 作用 |
| --- | --- |
| [`opencode-go-usage`](plugins/opencode-go-usage) | 读取 OpenCode Go 订阅的 5 小时、周、月三个窗口的额度 |
| [`minimax-quota`](plugins/minimax-quota) | 读取 MiniMax M Plan 的 5 小时、周两个窗口的额度 |
| [`better-experience`](plugins/better-experience) | 设置（Settings）页：放这个 bundle 的全局偏好 |

两个额度插件不再各自渲染自己的组件。它们只是各自 **Host 半边**和**文案**；输入框下方那个唯一的控件是这套 bundle 共享的浏览器半边画的。

它的**圆环**跟随会话当前用的模型 —— 把会话切到 MiniMax，圆环就显示 MiniMax 的额度，无需刷新 —— 它的**弹窗**把**两个套餐**都列出来，所以其中一个花完了，你一眼就能看到另一个还有没有余量。没在用的那个套餐**只在弹窗打开时**才被读。

**Settings → 更好的体验 → 显示** 把整个控件关掉，关闭即卸载，**不发起任何**额度请求。

偏好是实时的 —— 在设置页上改一下立刻生效，不用刷新。

## 安装

需要一个 profile 里带 Web carrier（`dsh-web-app`）的 DSH。在侧栏的 **Plugins** 页安装，或者用 `plugin_manager` 工具：

```jsonc
{ "action": "install_bundle", "target": "github:nullpoint333/dsh-plugins" }
```

装一次就把仓库里所有插件都装上，每一行可以单独启用 / 关闭。安装器在装之前用 `git ls-remote` 校验仓库存在，用的是 profile 目录里它自己的 Git 和代理配置，所以 SSH remote 和公司内网镜像走的是同一条路。

没有依赖、没有 install 脚本、没有 build 步骤 —— 那些 `client.js` 就是全部实现。

### 在新机器上第一次装

上面的 install 命令把 bundle 装到了硬盘上，但要让额度控件**真的**显示出来，还需要**四行都打开**。装完之后在 Plugins 页里把每一行启用（或者再用 `plugin_manager` 跑 `set_bundle` / `set_plugin`）：

| 行 | 为什么必须打开 |
| --- | --- |
| `dsh-plugins-host` | 仓库根的那一行，是其它所有行的容器。不开这个，其它任何东西都装不上。 |
| `opencode-go-usage` | 读 OpenCode Go 订阅的 Host 半边。关掉它，弹窗里 OpenCode Go 的那一节就读不到东西。 |
| `minimax-quota` | 读 MiniMax M Plan 的 Host 半边。同上，对应 MiniMax 那一节。 |
| `better-experience` | 设置页所在那一行 —— **Settings → 更好的体验 → 显示** 是唯一能关掉整个控件的地方。关掉它，控件照样工作，但用户没办法关掉它。 |

控件的可见性是**每个浏览器**的 `localStorage` 值（`dsh-plugins.better-experience.show-quota`），默认 **on** —— 所以新开机的浏览器一进来就能看到圆环。这是**故意**的：关掉它必须是一个显式的选择。**不应该**出现"插件装好但第一次开着没用、得让用户先去设置页找开关"这种局面。

凭据从 Harness 进程的**环境变量**读，不在仓库里写死 —— Host 半边不存凭据，bundle 也不会替你去读 `~/.bashrc`：

| 插件 | 读哪个 |
| --- | --- |
| `opencode-go-usage` | `OPENCODE_GO_API_KEY` |
| `minimax-quota` | `MINIMAX_CN_API_KEY`（以及对应的中文变体） |

如果 Harness 是 service 跑的，把变量写到它 unit 的 `Environment=` 里，不要写在你的 shell 里 —— 这样重启后还在。缺哪个 key 的时候，弹窗里会直接显示一行"未配置 X"，**圆环不会消失**，这样你总能看见哪儿不对。

如果公司机器只能通过内网镜像访问 GitHub，给 git 设一条 `insteadOf` 规则即可；`plugin_manager` 用的是 profile 目录里它自己的 git 和代理配置，安装路径跟你们 team 平时 clone 仓库**完全一样**。

### 离线安装（目标机器完全没网）

下面两条路在安装那一刻**完全不需要出网**。两条都靠同一个事实：`plugin_manager` 装包只跟 **git** 打交道（用 `git ls-remote` 校验仓库存在）。所以路径上唯一的前提是目标机器上有一个能用的 git。

**本地 bare 镜像**（团队维护自己插件时的标准做法）：

```sh
# 在一台能上网的机器上，跑一次：
git clone --bare https://github.com/nullpoint333/dsh-plugins.git /srv/mirror/dsh-plugins.git
git -C /srv/mirror/dsh-plugins.git update-server-info
# 把 /srv/mirror/dsh-plugins.git 搬到目标机器能读到的共享盘上。
```

在目标机器上，让 git 把那个镜像当成本地地址，安装命令**完全不变** —— git 一层就把 URL 改写掉了，**传输层根本没出网**：

```sh
git config --global url."/srv/mirror/dsh-plugins.git".insteadOf https://github.com/nullpoint333/dsh-plugins
# 然后 plugin_manager 里：
{ "action": "install_bundle", "target": "github:nullpoint333/dsh-plugins" }
```

`insteadOf` 这条规则是**全部窍门**：`plugin_manager` 看到的还是 GitHub URL，但 host 的 git 在 transport 层就把它改写成 `/srv/mirror/...`。`plugin_manager` 用来校验仓库的 `git ls-remote` 跑在镜像上，**不**跑在 GitHub 上。

**单文件 `git bundle`**（U 盘 / 慢 VPN 一次性拷贝）：

```sh
# 在源机器上，跑一次，把所有目标可能用到的分支都打进去：
git clone https://github.com/nullpoint333/dsh-plugins.git
cd dsh-plugins
git bundle create /tmp/dsh-plugins.bundle --all

# 把这个文件拷到目标机器。
```

在目标机器上，从 bundle 还原，再导出一份 bare 仓库给 `plugin_manager` 用：

```sh
git clone /path/to/dsh-plugins.bundle dsh-plugins
git -C dsh-plugins bundle verify </path/to/dsh-plugins.bundle   # 安全校验
# 导成 bare 仓库，让 manager 的 `git ls-remote` 能工作：
git clone --bare dsh-plugins /srv/mirror/dsh-plugins.git
git -C /srv/mirror/dsh-plugins.git update-server-info
# 然后 `git config --global url."file:///srv/mirror/...".insteadOf ...`，再安装。
```

bundle 是**单文件**，`plugin_manager` 永远不会直接读它 —— 它只跟 git 说话。所以**唯一**需要网络的一步是导出 bare 镜像的那次 `git clone`；之后每一次安装都离线。

如果你的安装是一次性的，还可以在 `insteadOf` 规则里直接指向 U 盘（`file://` URL）：

```sh
git config --global url."file:///mnt/usb/dsh-plugins.git".insteadOf https://github.com/nullpoint333/dsh-plugins
```

bundle 里的 `cordis.patch.yml`、`client.js`、`host.js`、各个 plugin 目录都是普通文件 —— `git clone --bare` 加 `update-server-info` 就给了 `plugin_manager` 需要读的一切，**不用从网络跑 JavaScript**。

### `opencode-go-usage`

OpenCode Go 把每个模型的额度定义为月度美元金额，并从中推算出更短的窗口：

| 窗口 | 额度 | 上游字段 |
| --- | --- | --- |
| 5 小时（rolling，5 小时滚动） | 月度限额的 20% | `rolling` |
| 周（week） | 月度限额的 50% | `weekly` |
| 月（month） | 月度限额的 100% | `monthly` |

输入框下方是一个紧凑的控件：标签 `5h`（中文 locale 显示 `小时`），旁边**一个圆环**（ring），按滚动窗口的已用份额填充，旁边带百分比。点开这个控件，弹窗里会显示周、月两个窗口的进度条、各自的百分比和重置时间、上次读取时间，以及一个"刷新"动作；圆环的 `title`（tooltip）里带 5 小时窗口的重置时间和倒计时。

**读取是"按节奏"，不是"轮询"。** 数据是按 plugin 持有的，不是按视图持有的 —— 切换会话时直接拿缓存渲染，不会重读；只在超过 `uiRefreshMs`（默认 5 分钟）后才重读，这也是挂在屏幕上的唯一一个 timer 的周期。**打开弹窗不会触发重读** —— **刷新（Refresh）**是唯一强制重读的动作。

`GET https://opencode.ai/zen/go/v1/usage` 返回：

```json
{ "usage": {
  "rolling": { "status": "ok", "percent": 2, "resetsAt": "2026-10-18T11:02:12.000Z" },
  "weekly":  { "status": "ok", "percent": 1, "resetsAt": "2026-10-19T00:00:00.000Z" },
  "monthly": { "status": "ok", "percent": 0, "resetsAt": "2026-11-18T06:01:17.000Z" } } }
```

那个调用需要 bearer key，所以留在 Host 半边。浏览器半边只从本插件注册的 loopback 路由 `/plugin/opencode-go-usage/quota` 拉投影过的百分比和重置时间，**永远拿不到 key**。key 是按请求通过 `ctx.credentials` 解析成 `OPENCODE_GO_API_KEY` 的 —— 轮换过的凭据下一调用就生效，不用重启 —— 找不到 `ctx.credentials` 时回退到同名环境变量。额度属于那个 key 背后的账号，所以**每台机器**显示它自己的那个账号的额度。

可选配置（每一项都有默认值），可以用 profile 自己的 `cordis.patch.yml` 覆盖：

```yaml
- id: opencode-go-usage
  config:
    endpoint: 'https://opencode.ai/zen/go/v1/usage'
    credentialRef: 'OPENCODE_GO_API_KEY'
    cacheMs: 5000
    requestTimeoutMs: 15000
    uiRefreshMs: 300000
```

### `minimax-quota`

MiniMax 的 M Plan 也是订阅，两个窗口独立刷新，**同一个** key 上的**所有**工具共享同一个额度：

| 窗口 | 覆盖 | 时长 |
| --- | --- | --- |
| 5 小时 | 非视频模型（文本、图像、音频） | 从首次使用起 5 小时 |
| 周 | 所有模型，包括视频 | 从首次使用起 7 天 |

非视频模型需要**两个窗口**都还有余额，5 小时花完了就会停下来，即使周额度几乎没动 —— 这正是双窗口显示存在的理由。

MiniMax 在自己的控制台和官方 CLI（`mmx quota`）里展示数字。本插件读的是 CLI 用的同一条路由：

```
GET https://api.minimax.cn/v1/token_plan/remains
Authorization: Bearer <M Plan subscription key>

{ "model_remains": [ { "model_name": "general",
    "start_time": …, "end_time": …, "remains_time": …,
    "current_interval_remaining_percent": 0,
    "weekly_start_time": …, "weekly_end_time": …,
    "current_weekly_remaining_percent": 86, "weekly_boost_permille": 1500 } ],
  "base_resp": { "status_code": 0, "status_msg": "success" } }
```

那个返回里有两点容易写反，**单独提一下**：

- **百分比表示的是"剩余"，不是"已用"。** Host 半边做了一次转换，所以这个 bundle 里所有 widget 画的都是同一件事（已用份额），而 MiniMax 弹窗把"已用"和"剩余"两个读数都印出来，而不是只挑一个。
- **名叫 `*_usage_count` 的字段其实是"剩余"**（用法名容易看反）。MiniMax 自己的 CLI 就是这么读的，只有在 `*_remaining_percent` 用"差值更小"的那种方式证伪它的时候才会回退到 `total - count`。Host 半边照搬这个逻辑，如果两个读数和上报的百分比差异超过 1 个点以上，**以上报的百分比为准**，不靠猜。

这条路由要的是**订阅** key（`sk-…`）。按量计费的 key 以 `sk-api-` 开头，属于另一条端点，是按账户余额计费的；本插件能识别出这种情况，并直接说"这不是订阅 key"，而不是报一个看起来空空的额度。**key 不会进到浏览器** —— Host 半边自己调，然后把投影后的份额和重置时间通过 `/plugin/minimax-quota/quota` 重新发布出来。

可选配置（每一项都有默认值）：

```yaml
- id: minimax-quota
  config:
    # 国际版 base 是 'https://api.minimax.io'；两个都服务这条路由。
    endpoint: 'https://api.minimax.cn'
    credentialRef: 'MINIMAX_CN_API_KEY'
    # 携带文本 / 图像 / 音频额度的 plan 条目。
    modelName: 'general'
    cacheMs: 5000
    requestTimeoutMs: 15000
    uiRefreshMs: 300000
```

### `better-experience`


这个插件拥有 **Settings → 更好的体验** 页 —— 给这个 bundle 的全局偏好一个家，下一个需要偏好的插件不用自己再造一个页面。

页面里一节一类问题，每一行的格式是：标签、说明、**当前取值会产生什么后果**而不是那个开关本身、以及一个控件（开关或者 `select`）。

| 偏好 | 键 | 默认 | 作用 |
| --- | --- | --- | --- |
| 显示额度 | `show-quota` | **on** | 在输入框下方显示控件：圆环跟随当前会话所用的模型，弹窗里同时列出两个套餐。关掉它控件就卸载，不发起任何请求。 |
| 任务完成时发送通知 | `notify-on-completion` | off | 模型完成一轮时发桌面通知。 |

键都存在 `localStorage['dsh-plugins.better-experience.<name>']` 下，这样以后 bundle 里的其它插件**不会**撞名。等于默认值的就**删 key**来存 —— 这样以后发新版改默认值时不用做迁移。存进去的值如果这个偏好不接受（陈旧的 key、或者手改过），回退到默认值，而不是让 UI 落到一个未知状态。

实时值不是每次 render 时去 `localStorage` 读 —— 同一 tab 里 `storage` 事件根本不触发，读了也唤醒不了已挂载的视图。改成**每个 activation 创建一个内存 store，所有订阅者共享**：设置页写它，输入框下的控件读它。**这就是**为什么"改一下立刻生效，不用刷新"；`localStorage` 只是它背后的持久化层。仓库的离线检查（下文）覆盖了这两条路径。

#### 弹窗，以及"什么时候会读什么"

弹窗的存在是为了回答一个问题：**"这个套餐花完了，另一个还有没有余量？"** 所以它把**这个 bundle 能读到的所有套餐**都列出来，每个都带它所有的窗口，并且把会话当前正在花的那一个**标记出来**。

这决定了请求模式（这一块很容易写错）：

| 状态 | 读什么 |
| --- | --- |
| 控件挂着，弹窗关着 | 只读当前模型在花的那一个 —— 圆环上的数字 |
| 弹窗打开 | 其它套餐也读一次，开的那一瞬间读 |
| 弹窗再关掉 | 其它套餐的订阅撤销，它们的 timer 停止 |
| 控件卸载（偏好关闭） | 什么都不读 |

**没在用的套餐永远不会在后台轮询。** 每个区块各印自己的"读取于"时间，而不是共用一行 —— 共用一行的话必然有一个是假的：一个挂在 timer 上、一个是按需读的，时间本来就该不一样。

#### 圆环怎么跟着模型走

dock 条目读会话自己的 `modelSelection` 投影，把它的 provider 跟每个 Host 半边声明的 provider 列表（`opencode-go`，以及 `minimax-cn` / `minimax`）匹配。模型一换，dock 条目会带着新的 provider 重新 render，圆环就跟着换。

那个投影的形状是 `{ lastUsed, next }`，每个值是 `{ provider, model, reasoningEffort? }` 或 null：`next` 是"下一请求该用的"，`lastUsed` 是"上一次实际用的"。dock 条目优先 `next` —— 也就是用户当前的选择 —— `lastUsed` 只是给那种"next 还没写"的会话做兜底。（composer 自己的模型选择器在内部用了一个 catalog store 来合并这个投影，合并后的键叫 `current`；那是它**内部**的形状，不是投影的形状 —— 在这里读 `current` 读不到东西。）

当模型在这个 bundle 没有对应套餐时（比如官方 DeepSeek 账号），触发器（trigger）**不消失**，只是不画圆环；弹窗照样能打开、照样列两个套餐。这是**故意**的：让触发器消失就拿走了"问这个问题"的唯一入口。

有两个性质让这个设计稳，而不是脆：

- `modelSelection` 是**会话作用域**的投影，dock 条目本身也是会话作用域的，作用域匹配。（在 *root* 作用域的页面里调一个会话作用域的 standard hook，会触发 `SlotAssemblyError`，那正是曾经把设置页搞白板的 bug；规则在本文 *Adding a plugin* 一节。）
- 投影 store **对每一个 key 都定义一个 face**（人脸 / 取值面）：未知的、还没写入的 key 是 `undefined` 快照，不是抛错。所以意外的服务商只是让 dock 空着，不会把 composer 搞挂；一个没装 model-selection 插件的 profile，行为也一样。

一个这个 bundle 不读的 provider（比如官方 DeepSeek 账号）显示空 —— 这是诚实的答案，而不是留一个过期的数字。

#### 通知这一行

通知这一行的开关、持久化、可用性都通了，**"发送测试通知"**这个动作能验证 OS 的通知权限和 API 路径，不用真等任务结束。但**自动**在任务完成时发通知这件事**还没写**：它需要会话状态，而设置页本身是 root 作用域的，读不到会话作用域的 hook。运行时应该放在会话作用域的 dock 条目里 —— 也就是圆环旁边那个会话作用域位置，那一块已经能拿到同一个偏好 store 了。

## 离线检查

浏览器半边可以**不打开浏览器**就验证。两个脚本都通过 module-loader shim 加载 `client.js` 并注入 React，所以能抓到那种浏览器里只会显示一个"空白槽位"的 render 期错误：

```
node render-test.cjs   <client.js>                    # 两个 entry 都能 render
node interact-test.cjs <client.js>                    # 圆环、弹窗、无 Notifications API
node interact-test.cjs <client.js> --notifications    # 圆环、弹窗、有权限
```

`interact-test.cjs` 在 jsdom DOM 里挂载两个 entry，**真的去点**，所以它覆盖了纯 render 看不出来的东西：

- 圆环跟随模型选择，**未生效的**选择必须赢过**上一次实际用的**；
- 投影缺失不抛错；
- 打开弹窗后**两个**套餐都列出来、顺序稳定、当前那个被标记；当前模型在这个 bundle 没有对应套餐时也照样这样（触发器不消失、显示无环）；
- 控件关掉即卸载，偏好 round-trip。

它还把 root standard seat 上的 hook 替换成会**抛错**的桩 —— 这就是发现"在 root 作用域的页面上意外调了会话 hook"那一类问题的方法，能在它把页面搞白板之前就抓住。

## 仓库布局

仓库根**就是**包根，这也是 `github:nullpoint333/dsh-plugins` 能直接当 install 目标的原因：install spec 写的是一个仓库，manager 装的就是它在里面找到的那个包。

```
package.json                      唯一的包：bundle + client 声明
cordis.patch.yml                  一个 Loader 行一个 plugin，加根那一行
host.js                           包根行（见下文）
client.js                         这个包唯一的浏览器半边 —— 所有 UI
locale/{en,zh}.json               bundle 在 Plugins 页面里的卡片
icon.svg
plugins/
  opencode-go-usage/
    index.js                      Host 半边：上游调用 + loopback 路由
    locale/{en,zh}.json           这个 plugin 在 Plugins 页面里自己的行
    icon.svg
  minimax-quota/
    index.js                      Host 半边：plan 调用 + loopback 路由
    locale/{en,zh}.json
    icon.svg
  better-experience/
    index.js                      Host 半边：空（页面是纯浏览器的）
    locale/{en,zh}.json
    icon.svg
```

子路径 plugin 各自 export 自己的 `locale/*.json` 和 `icon`，**从来**不会作为一个独立的包被读。

两个额度套餐共用一个浏览器实现：每个 Host 半边都把自己的 provider 返回包装成同一种窗口形状（`percent` = 已用份额，加 `resetsAt`），`client.js` 里一个 `QUOTA_WIDGETS` 条目写明路由、它支持哪些 provider、和它的窗口标签。共用的界面文案（chrome）只放在 `better-experience` 字典里写一次；每个 Host 半边自己的字典只放**真的属于它**的那些文案。

所以加第三个套餐就是 —— 一个 Host 半边、一个 `QUOTA_WIDGETS` 条目、两份字典 —— **不用**写新的视图代码，它会自动出现在弹窗里，跟其他两个并排。

### 为什么有一个独立的"根行"

浏览器半边属于**包**而不属于 Loader 行：模块 id 是包名，Host 是从包的 `exports["./client"]` 组装 bundle 的。Host 只在**行指向包根**的时候才会扫那一行做这个声明 —— 这一点通过把同一个探针包插两次验证过：先以 `pkg/probe`、再以 `pkg`，**只有**后一种形式才让 slot 注册跑起来。

所以 `host.js` 是个锚点，**它自己不注册任何东西**。把锚点和功能 plugin 分开是故意的：如果以某个功能 plugin 为根，禁用它会把所有其他 plugin 的 UI 一并拖下来。

### 添加一个 plugin

1. `plugins/<name>/index.js` —— Host 半边。export `apply(ctx, config)`，声明它需要的 `inject` 服务。
2. 在 `exports` 里加 `"./<name>": "./plugins/<name>/index.js"`，有显示元数据的话再加 `./<name>/locale/*.json` 和 `./<name>/icon`。
3. 在 `cordis.patch.yml` 里加一行：
   ```yaml
   - id: <name>
     name: 'dsh-plugins/<name>'
   ```
4. UI 在 `client.js` 里注册 —— **这个 bundle 共享这一个**浏览器半边，没有"每个 plugin 一个浏览器 bundle"这种东西。
5. `plugins/<name>/locale/{en,zh}.json` 给这个 plugin 在 Plugins 页面自己的行提供标题和说明。
6. **编辑完 plugin 文件后，要重新发布才会生效。** Host 在 bundle 激活的那一刻 snapshot 包的 client 入口，所以单改 `client.js` —— 或者改某个 plugin 的 Host 半边 —— 不会自己跑到正在跑的 composition 里去；老的模块会一直回答，直到你把 bundle 重新组装一次。把 bundle 关掉再打开（Plugins 页面，或者 `plugin_manager` `set_bundle`），然后刷新页面让浏览器拿到新的 bundle。
7. **全局偏好挂在 `better-experience` 页上，不要新开一个自己的页面。** 这个 bundle 里的后续 plugin 应该把它的偏好加进那一节，存在 `localStorage['dsh-plugins.better-experience.<key>']` 下，这样页面仍然是管理 bundle 全局选项的**唯一**地方。
8. **永远不要调用一个作用域和当前 slot 不匹配的 standard `use*` hook。** Renderer 用 root standard binding（`dsh-client-ui-renderer` 里的 `standardKit`）来组装 root entry 的 props，所以像 `useSessions` 和 `useSessionStatus` 这种名字**确实**作为 props 存在。但一个 *session* 作用域的 hook 在 *root* 作用域的 entry 上是**没有源**的，loader 会用 `SlotAssemblyError` 来表示这件事 —— 而 entry 的错误边界**故意**把它重新抛出**而不是**捕获。表现不是那一行崩了，是**整页空白且没有任何可见错误**。`settings.section` 页面是 root 作用域的：只用 React 自己的 hook 和 entry 自己的 inject face，会话状态从会话作用域的 slot 读。

选这种布局之前两条心里有数：

- 所有 UI 共享一个 bundle，所以**带 UI 的 plugin 不能从本仓库单独发布** —— 它永远是整个 bundle 的一部分。
- 单个 git spec 没法指向子目录，所以把这份代码拆成"一个仓库里几个包"会把发布路径从 `github:` 安装搬到一个 registry。

## 限制

- `opencode-go-usage` 需要 Web carrier（`ctx.webServer`）。一个只有 Electron 的 profile 通过 `file://` 加载页面，这个 plugin 保持未激活。
- 它的路由是用 `exact` 注册的，所以它**先于** Web shell 的 fallback handler 被匹配，**不**走连接自己的授权。它只暴露百分比，**绝不**包含 API key，listener 由 `webserver` 行的 `host` 配置绑在 loopback 上。
- `status` 不是 `ok` 或者 `percent >= 100` 的窗口按"错误"渲染；`percent >= 80` 按"警告"渲染。

### 在"工作副本"和"已发布包"之间切换

本地路径安装（`link:`）跑的是这个目录，所以编辑立刻生效；`github:` 安装跑的是一个下载下来的副本。在 Windows 上反过来切是不对称的 —— `remove_bundle` 会报 `applied`，但 pnpm 把 `node_modules/<name>` 那个 symlink 留下来，下次再装会报错：

```
[ERR_PNPM_EPERM] [importPackage ...\node_modules\dsh-plugins]
EPERM: operation not permitted, rename '..._tmp_<pid>_<n>' -> '...\dsh-plugins'
```

切回已发布包之前先手动把那个 symlink 删掉，等 manager 切回 `link:` 时再让它重新建。从来没装过本地链接的机器不受影响 —— 没有那个 symlink 让 rename 撞上。

## 协议

MIT —— 见 [LICENSE](LICENSE)。
