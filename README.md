# TGbot-D1-Private

基于 Cloudflare Workers + D1 数据库的 Telegram 入群验证与用户管理机器人。

> **声明**：本项目借鉴自开源项目 [moistrr/TGbot-D1](https://github.com/moistrr/TGbot-D1)，在其基础上进行了二次开发、功能增强与 Bug 修复，包括但不限于：WebApp initData 签名校验、指纹去重原子化、WebRTC IP 封禁、CF 人机验证开关、验证问答开关、IP 超链接查询、命令菜单 scope 分离等。感谢原作者的开源贡献。

---

## 功能特性

- **入群验证**：Cloudflare Turnstile 人机验证 + 自定义验证问答，两者可独立开关或叠加使用
- **设备指纹**：采集 Canvas / WebGL / Audio / 字体 / WebRTC IP 等多维度指纹，原子化去重（一个用户一条指纹）
- **WebRTC IP 封禁**：封禁指定 IP 后，用户验证时若公网 IP 或 WebRTC IP 命中即自动拦截
- **黑名单联动**：黑名单用户私聊或提交验证时收到明确拦截提示
- **用户资料卡**：自动创建/刷新/重建用户资料卡，支持屏蔽、静音、置顶、查看资料
- **管理命令菜单**：管理群显示完整管理命令，普通用户私聊仅显示 `/start`
- **IP 查询跳转**：资料卡与指纹信息中的公网 IP / WebRTC IP 可点击跳转 ippure.com 查询
- **自动回复 / 关键词屏蔽 / 转发过滤**：可配置的智能消息处理

---

## 前置准备

1. **Cloudflare 账号**：注册并登录 [Cloudflare](https://dash.cloudflare.com/)
2. **Node.js**：本地安装 Node.js 18+ 与 npm
3. **Telegram Bot**：通过 [@BotFather](https://t.me/BotFather) 创建机器人，获取 `BOT_TOKEN`
4. **Telegram 管理群**：创建一个超级群组（开启话题功能），将其作为管理群，获取群 ID（负数）
5. **Cloudflare Turnstile**：在 Cloudflare 控制台创建 Turnstile 站点，获取 `Site Key` 与 `Secret Key`

---

## 部署流程

### 1. 克隆项目

```bash
git clone <你的仓库地址>
cd TG-bot
npm install
```

### 2. 创建 D1 数据库

```bash
npx wrangler d1 create tg-bot-db
```

执行后会输出 `database_id`，将其填入下一步的 `wrangler.toml`。

### 3. 配置 wrangler.toml

编辑项目根目录的 `wrangler.toml`：

```toml
name = "tgbot-d1"
main = "src/index.js"
compatibility_date = "2026-07-01"

[vars]
ADMIN_IDS = "你的Telegram用户ID"
ADMIN_GROUP_ID = "你的管理群ID（负数，如 -100xxxxxxxxxx）"
APP_BASE_URL = "https://你的Worker域名"
BOT_USERNAME = "你的机器人用户名（不带@）"

# D1 数据库绑定，变量名必须严格为 TG_BOT_DB（代码读取 env.TG_BOT_DB）
[[d1_databases]]
binding = "TG_BOT_DB"
database_name = "tg-bot-db"
database_id = "上一步获取的database_id"
```

> **说明**：`ADMIN_IDS` 为主管理员 Telegram 用户 ID（可填多个，逗号分隔）。`APP_BASE_URL` 为 Worker 部署后的访问域名（首次部署后可从 Cloudflare 控制台获取，再回填此处重新部署）。

### 4. 配置机密变量

以下变量属于敏感信息，**不要**写入 `wrangler.toml`，通过 `wrangler secret put` 单独配置：

```bash
# Telegram Bot Token
npx wrangler secret put BOT_TOKEN

# Cloudflare Turnstile 密钥
npx wrangler secret put TURNSTILE_SECRET_KEY

# Cloudflare Turnstile 站点密钥
npx wrangler secret put TURNSTILE_SITE_KEY

# Webhook 密钥（自定义一个随机字符串）
npx wrangler secret put WEBHOOK_SECRET
```

每条命令执行后会提示输入对应值，输入后回车即可。

### 5. 部署到 Cloudflare Workers

```bash
npx wrangler deploy
```

部署成功后会输出 Worker 域名，形如 `https://tgbot-d1.<你的子域>.workers.dev`。将该域名回填到 `wrangler.toml` 的 `APP_BASE_URL`，再次部署一次。

### 6. 配置 Webhook

部署完成后，向 Telegram 注册 Webhook。**注意必须订阅 `message_reaction` 事件**（用于检测自赞等行为联动）：

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://你的Worker域名/webhook/<WEBHOOK_SECRET>",
    "allowed_updates": [
      "message",
      "edited_message",
      "callback_query",
      "message_reaction"
    ]
  }'
```

将 `<BOT_TOKEN>`、`你的Worker域名`、`<WEBHOOK_SECRET>` 替换为实际值。

验证 Webhook 是否注册成功：

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

### 7. 数据库初始化

数据库表会在 Worker 首次启动时**自动创建**（`dbMigrate` / `EnsureMigration` 自动执行），无需手动执行 SQL。

Worker 启动时会自动创建以下 9 张表与索引：

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

**迁移兼容**：`dbMigrate` 还会通过 `ensureUserColumn` 自动为旧库补齐 `topic_creating`、`topic_lock_at` 等新增列，无需手动 ALTER。

如需手动初始化或重置，可创建 `schema.sql`（内容参考上面的建表语句）后执行：

```bash
npx wrangler d1 execute tg-bot-db --remote --file=./schema.sql
```

查看现有表结构：

```bash
npx wrangler d1 execute tg-bot-db --remote --command "SELECT name FROM sqlite_master WHERE type='table'"
```

查看表数据（示例）：

```bash
npx wrangler d1 execute tg-bot-db --remote --command "SELECT user_id, user_state, is_blocked FROM users LIMIT 10"
```

### 8. 配置 Cloudflare Turnstile

1. 登录 Cloudflare 控制台 → Turnstile
2. 添加站点，域名填入你的 Worker 域名
3. 获取 `Site Key` 与 `Secret Key`
4. 通过 `wrangler secret put` 已在第 4 步配置

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

> 命令菜单统一注册所有管理命令（不含 `/start`），非管理员调用时由 `isAdminUser` 拦截。`/start` 可直接输入触发。

---

## 配置说明

### 环境变量（wrangler.toml）

| 变量 | 说明 |
|------|------|
| `ADMIN_IDS` | 主管理员 Telegram 用户 ID（多个用逗号分隔） |
| `ADMIN_GROUP_ID` | 管理群 ID（负数） |
| `APP_BASE_URL` | Worker 部署域名 |
| `BOT_USERNAME` | 机器人用户名（不带 @） |

### 机密变量（wrangler secret）

| 变量 | 说明 |
|------|------|
| `BOT_TOKEN` | Telegram Bot Token |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile 服务端密钥 |
| `TURNSTILE_SITE_KEY` | Cloudflare Turnstile 站点密钥 |
| `WEBHOOK_SECRET` | Webhook 路径密钥（自定义随机字符串） |

### 运行时可配置项（管理菜单）

通过机器人管理菜单动态配置，存储于 D1 数据库 `config` 表：

- 欢迎消息
- CF 人机验证开关（`turnstile_enabled`）
- 验证问题 / 验证答案
- 自动回复规则、关键词屏蔽、转发过滤等

---

## 致谢

- 原项目：[moistrr/TGbot-D1](https://github.com/moistrr/TGbot-D1)
- 平台：[Cloudflare Workers](https://workers.cloudflare.com/) + [D1 数据库](https://developers.cloudflare.com/d1/)
- 验证：[Cloudflare Turnstile](https://www.cloudflare.com/products/turnstile/)

---

## 许可

请遵循原项目 [moistrr/TGbot-D1](https://github.com/moistrr/TGbot-D1) 的许可协议。
