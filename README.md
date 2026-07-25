# TGbot-D1-Private

基于 Cloudflare Workers + D1 数据库的 Telegram 入群验证与用户管理机器人。

> **声明**：本项目借鉴自开源项目 [moistrr/TGbot-D1](https://github.com/moistrr/TGbot-D1)，在其基础上进行了二次开发、功能增强与 Bug 修复，包括但不限于：WebApp initData 签名校验、指纹去重原子化、WebRTC IP 封禁、CF 人机验证开关、验证问答开关、IP 超链接查询等。感谢原作者的开源贡献。

---

## 功能特性

- **入群验证**：Cloudflare Turnstile 人机验证 + 自定义验证问答，两者可独立开关或叠加使用
- **设备指纹**：采集 Canvas / WebGL / Audio / 字体 / WebRTC IP 等多维度指纹，原子化去重（一个用户一条指纹）
- **WebRTC IP 封禁**：封禁指定 IP 后，用户验证时若公网 IP 或 WebRTC IP 命中即自动拦截
- **黑名单联动**：黑名单用户私聊或提交验证时收到明确拦截提示
- **用户资料卡**：自动创建/刷新/重建用户资料卡，支持屏蔽、静音、置顶、查看资料
- **IP 查询跳转**：资料卡与指纹信息中的公网 IP / WebRTC IP 可点击跳转 ippure.com 查询
- **自动回复 / 关键词屏蔽 / 转发过滤**：可配置的智能消息处理

---

## 前置准备

部署前你需要准备好以下内容：

1. **Cloudflare 账号**：注册并登录 [Cloudflare](https://dash.cloudflare.com/)，全程在网页面板操作，不需要安装任何本地工具
2. **Telegram Bot**：通过 [@BotFather](https://t.me/BotFather) 创建机器人，记下 `BOT_TOKEN`
3. **Telegram 管理群**：创建一个超级群组（开启话题功能）作为管理群，记下群 ID（负数，形如 `-100xxxxxxxxxx`）；同时记下你自己的 Telegram 用户 ID
4. **Cloudflare Turnstile**：在 Cloudflare 面板创建 Turnstile 站点，记下 `Site Key` 与 `Secret Key`

> 不需要 Node.js、npm、git、wrangler，全部在 Cloudflare 网页面板完成。

---

## 部署流程

整个部署都在 Cloudflare 网页面板完成，核心就是：建数据库 → 建 Worker 粘贴代码 → 绑定数据库 → 填变量 → 配 Webhook。

### 1. 创建 D1 数据库

1. 登录 [Cloudflare 面板](https://dash.cloudflare.com/)
2. 左侧菜单 **Workers 和 Pages** → **D1** → **创建数据库**
3. 数据库名称随便填，比如 `tg-bot-db`，点创建
4. 创建完成后，记住这个数据库名称，后面绑定时要用

### 2. 创建 Worker 并粘贴代码

1. 左侧菜单 **Workers 和 Pages** → **创建应用程序** → **创建 Worker**
2. 给 Worker 起个名字，比如 `tgbot-d1`，点 **部署**
3. 部署完成后点 **编辑代码**
4. 把本项目 `src/index.js` 的**全部内容**复制，粘贴到编辑器里（覆盖掉默认的 hello world 代码）
5. 点右上角 **部署**

> 之后每次更新代码，都是来这里粘贴新代码然后点部署，无需任何命令行操作。

### 3. 绑定 D1 数据库

Worker 需要能访问到第 1 步创建的数据库：

1. 进入你的 Worker 页面 → **设置** → **绑定** → **添加绑定** → 选 **D1 数据库**
2. **变量名称**填：`TG_BOT_DB`（必须和代码里一致，区分大小写）
3. **D1 数据库**选择刚才创建的 `tg-bot-db`
4. 点 **部署** 保存

### 4. 配置环境变量

进入 Worker 页面 → **设置** → **变量和机密**，添加以下变量：

**明文变量（选 Text 类型）**：

| 变量名 | 值 | 说明 |
|--------|-----|------|
| `ADMIN_IDS` | `你的用户ID` | 你的 Telegram 用户 ID，多个用逗号分隔 |
| `ADMIN_GROUP_ID` | `-100xxxxxxxxxx` | 管理群 ID（负数） |
| `APP_BASE_URL` | `https://tgbot-d1.你的子域.workers.dev` | Worker 的访问域名，部署后在 Worker 概览页能看到 |
| `BOT_USERNAME` | `你的机器人用户名` | 不带 @ 符号 |

**加密变量（选 Encrypt 类型，即 Secret）**：

| 变量名 | 值 | 说明 |
|--------|-----|------|
| `BOT_TOKEN` | BotFather 给的 Token | Telegram 机器人令牌 |
| `TURNSTILE_SECRET_KEY` | Turnstile 密钥 | Cloudflare Turnstile 的 Secret Key |
| `TURNSTILE_SITE_KEY` | Turnstile 站点密钥 | Cloudflare Turnstile 的 Site Key |
| `WEBHOOK_SECRET` | 自己编一段随机字符串 | 用于 Webhook 地址校验，比如 `mySecret123xyz` |

全部添加后点 **部署** 保存。

> **关于 `APP_BASE_URL`**：首次创建 Worker 时还不知道域名，可以先空着，部署一次后回到 Worker 概览页看到形如 `https://tgbot-d1.xxx.workers.dev` 的域名，再回来填上这个变量并重新部署。

### 5. 配置 Cloudflare Turnstile

1. Cloudflare 面板 → **Turnstile** → **添加站点**
2. 域名填你的 Worker 域名（`tgbot-d1.xxx.workers.dev`）
3. 创建后获取 `Site Key` 和 `Secret Key`
4. 这两个值已经在第 4 步配置到环境变量里了

### 6. 配置 Webhook

Worker 部署好后，需要告诉 Telegram 把消息发到你的 Worker。**必须订阅 `message_reaction` 事件**（用于自赞检测联动）。

最简单的方式：直接在浏览器地址栏打开下面这个链接（把尖括号内容替换成你的实际值）：

```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://你的Worker域名/webhook/<WEBHOOK_SECRET>&allowed_updates=%5B%22message%22%2C%22edited_message%22%2C%22callback_query%22%2C%22message_reaction%22%5D
```

把 `<BOT_TOKEN>`、`你的Worker域名`、`<WEBHOOK_SECRET>` 替换成你的实际值，回车访问。看到返回 `"ok":true` 就说明配置成功了。

验证是否配置成功，浏览器打开：

```
https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo
```

如果返回里有 `"url":"https://你的Worker域名/webhook/..."` 且 `last_error_message` 为空，就说明正常。

### 7. 数据库自动初始化（无需手动操作）

配置完 Webhook 后，当第一条消息到达 Worker 时，数据库会**自动建表**，不需要你手动执行任何 SQL。

Worker 启动时自动创建以下 9 张表：

| 表名 | 用途 | 关键字段 |
|------|------|----------|
| `config` | 运行时配置（欢迎消息、验证问答、开关等） | `key` PK, `value` |
| `users` | 用户状态记录 | `user_id` PK, `user_state`, `is_blocked`, `is_muted`, `topic_id`, `info_card_message_id`, `user_info_json` |
| `messages` | 用户消息归档 | `(user_id, message_id)` PK, `text`, `date` |
| `processed_updates` | Update 去重（防重复处理） | `update_id` PK |
| `verify_sessions` | 验证会话 | `session_id` PK, `user_id`, `status`, `fingerprint_id`, `expires_at` |
| `fingerprints` | 设备指纹（每用户一条，原子 upsert 去重） | `id` PK, `user_id`（唯一索引）, `pub_ip`, `webrtc_ip`, `device_json`, `device_hash` |
| `fingerprint_tags` | 指纹标签 | `id` PK, `fingerprint_id`, `tag`, `note` |
| `blacklist` | 用户黑名单 | `user_id` PK, `reason`, `source` |
| `banned_ips` | IP 封禁列表（公网 IP + WebRTC IP） | `ip` PK, `reason` |

**自动创建的索引**：`idx_users_topic_id`、`idx_messages_date`、`idx_processed_updates_time`、`idx_verify_sessions_user`、`idx_fingerprints_user`、`idx_fingerprints_user_hash`、`idx_fingerprint_tags_fp`，以及 `fingerprints(user_id)` 唯一索引（用于原子去重）。

**迁移兼容**：代码会自动为旧库补齐 `topic_creating`、`topic_lock_at` 等新增列，老用户升级时无需手动改库。

> 想查看数据库里有什么表或数据，可以在 Cloudflare 面板的 D1 页面 → 选你的数据库 → **执行 SQL** 标签里直接写 SQL 查询，例如 `SELECT name FROM sqlite_master WHERE type='table'`。

---

## 命令说明

### 普通用户（私聊）

| 命令 | 说明 |
|------|------|
| `/start` | 启动机器人 / 触发验证流程 |

### 管理员（管理群）

| 命令 | 说明 |
|------|------|
| `/start` | 启动 / 触发验证流程（可用于测试） |
| `/ban` | 封禁当前话题用户 |
| `/unban` | 解除当前话题用户封禁 |
| `/delete` | 删除被回复的消息 |
| `/terminate` | 删除当前用户话题 |
| `/card` | 重新创建当前用户资料卡 |
| `/admin` | 管理命令（指纹标签 / 黑名单 / IP 封禁） |
| `/admin banip <IP> [原因]` | 添加 IP 封禁 |
| `/admin unbanip <IP>` | 解除 IP 封禁 |
| `/admin baniplist` | 查看封禁 IP 列表 |
| `/testverify [用户ID]` | 测试指定用户的验证流程 |
| `/reset [用户ID]` | 重置指定用户的验证状态 |
| `/fp [用户ID]` | 查看指定用户的指纹信息 |

> 管理命令仅在管理群（`ADMIN_GROUP_ID`）内、且发送者在 `ADMIN_IDS` 或授权管理员列表中时才会执行，非管理员调用会被拦截。

---

## 配置说明

### 环境变量（Worker 设置 → 变量和机密）

| 变量 | 类型 | 说明 |
|------|------|------|
| `ADMIN_IDS` | 明文 | 主管理员 Telegram 用户 ID（多个用逗号分隔） |
| `ADMIN_GROUP_ID` | 明文 | 管理群 ID（负数） |
| `APP_BASE_URL` | 明文 | Worker 部署域名 |
| `BOT_USERNAME` | 明文 | 机器人用户名（不带 @） |
| `BOT_TOKEN` | 加密 | Telegram Bot Token |
| `TURNSTILE_SECRET_KEY` | 加密 | Cloudflare Turnstile 服务端密钥 |
| `TURNSTILE_SITE_KEY` | 加密 | Cloudflare Turnstile 站点密钥 |
| `WEBHOOK_SECRET` | 加密 | Webhook 路径密钥（自定义随机字符串） |

### 运行时可配置项（机器人管理菜单）

通过机器人管理菜单动态配置，存储于 D1 数据库 `config` 表，改完即时生效，无需重新部署：

- 欢迎消息
- CF 人机验证开关（`turnstile_enabled`，默认开启）
- 验证问题 / 验证答案
- 自动回复规则、关键词屏蔽、转发过滤等

> **验证模式说明**：CF 人机验证和验证问答可独立开关。两者都开 = 双重验证；关掉 CF 验证 = 仅问答验证；关掉问答 = 仅 CF 验证。但两者不能同时关闭（代码会拒绝验证并提示配置错误）。

---

## 更新代码

以后要更新代码，只需要：

1. 进入 Cloudflare 面板 → 你的 Worker → **编辑代码**
2. 把新版 `src/index.js` 全部内容粘贴覆盖
3. 点 **部署**

数据库和已配置的环境变量都不受影响，无需重新设置。

---

## 致谢

- 原项目：[moistrr/TGbot-D1](https://github.com/moistrr/TGbot-D1)
- 平台：[Cloudflare Workers](https://workers.cloudflare.com/) + [D1 数据库](https://developers.cloudflare.com/d1/)
- 验证：[Cloudflare Turnstile](https://www.cloudflare.com/products/turnstile/)

---

## 许可

请遵循原项目 [moistrr/TGbot-D1](https://github.com/moistrr/TGbot-D1) 的许可协议。
