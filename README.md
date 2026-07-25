## 🚀 Telegram 双向机器人（Cloudflare Workers + D1）

基于 Cloudflare Workers 和 D1 数据库的 Telegram 双向中继机器人。将用户私聊消息转发到管理员群组的话题（Topic）中，管理员在话题中回复即可中继回用户。集成 **Cloudflare Turnstile 人机验证** 和 **静默指纹采集**，有效防止机器人滥用。

---

### 核心特性

1. **双向中继与话题模式**
   - 每个用户私聊会话转发到管理员群组的独立话题
   - 话题名称动态显示用户昵称和 ID
   - 管理员在话题中回复即可自动转发回用户

2. **D1 数据库持久化**
   - 使用 Cloudflare D1 (SQLite) 存储用户状态、话题 ID 和所有配置
   - 数据库表自动迁移创建，无需手动建表

3. **Cloudflare Turnstile 人机验证**
   - 用户首次使用前需通过人机验证
   - 验证页面模拟 Cloudflare 经典挑战界面（橙云 logo + Verifying you are human）
   - 支持深色主题，适配 Telegram WebApp

4. **静默指纹采集**
   - 验证过程中后台静默采集设备指纹，用户无感知
   - 采集信号：Canvas、WebGL、Audio、OS、CPU、Screen、Fonts、WebRTC 公网 IP
   - 指纹相似度匹配（网络 + 设备信号，60% 阈值）
   - 支持指纹标签管理和黑名单联动

5. **完整的管理员配置菜单**
   - 管理员私聊机器人发送 `/start` 进入菜单驱动的配置界面
   - 在线编辑验证配置、屏蔽阈值、自动回复规则、关键词屏蔽等
   - 注意是私聊 BOT，不是在群组内发送 /start

6. **内容过滤与安全**
   - 关键词黑名单，超过屏蔽阈值自动屏蔽用户
   - 内容类型过滤：纯文本、媒体、链接、转发消息、音频/语音、贴纸/GIF
   - Webhook 安全密钥验证，防止伪造请求

7. **用户管理**
   - 每个用户话题顶部资料卡提供一键屏蔽/解禁和置顶
   - `/ban` 封禁、`/unban` 解禁指令
   - `/card` 手动重建资料卡
   - 黑名单和静音用户汇总

8. **消息处理**
   - 已编辑消息通知（修改前后对比）
   - 消息备份群组功能
   - 协同多账号处理（授权群组成员回复）
   - Update 消息去重，防止重复转发

---

### 部署方式（Wrangler CLI）

本项目使用 Wrangler CLI 部署，适合有一定技术基础的用户。如需 Dashboard 网页操作，可参考仓库历史版本的教程。

#### 前置准备

1. 注册 [Cloudflare](https://www.cloudflare.com/) 账号
2. 创建一个 Telegram Bot（通过 [@BotFather](https://t.me/BotFather)）
3. 创建一个超级群组并开启话题（Topics）模式
4. 将 Bot 拉入群组并提权为管理员（需要「管理话题」权限）
5. 安装 [Node.js](https://nodejs.org/)（18+）

#### 步骤一：克隆项目

```bash
git clone https://github.com/ya950/TGbot-D1.git
cd TGbot-D1
npm install
```

#### 步骤二：登录 Cloudflare

```bash
npx wrangler login
```

浏览器会打开授权页面，点击允许即可。

#### 步骤三：创建 D1 数据库

```bash
npx wrangler d1 create tg-bot-db
```

命令会输出 `database_id`，将其填入下一步的 `wrangler.toml`。

#### 步骤四：配置 wrangler.toml

编辑项目根目录的 `wrangler.toml`：

```toml
name = "tgbot-d1"
main = "src/index.js"
compatibility_date = "2026-07-01"

[vars]
ADMIN_IDS = "你的Telegram用户ID"
ADMIN_GROUP_ID = "-100你的超级群组ID"
APP_BASE_URL = "https://你的Worker域名"
BOT_USERNAME = "你的Bot用户名"

[[d1_databases]]
binding = "TG_BOT_DB"
database_name = "tg-bot-db"
database_id = "步骤三获取的database_id"
```

> 获取你的用户 ID：私聊 [@nmbot](https://t.me/nmbot) 发送 `/id`
> 获取群组 ID：将 @nmbot 拉入群组发送 `/id`（必须 -100 开头）

#### 步骤五：创建 Cloudflare Turnstile 验证组件

1. 登录 Cloudflare Dashboard → Turnstile
2. 点击添加组件，名称随意（如 `tg-bot-verify`）
3. **模式选择 Managed**（重要：不要选 Invisible，否则不显示验证界面）
4. 域名填入你的 Worker 域名
5. 创建后获取 **Site Key** 和 **Secret Key**

#### 步骤六：设置 Secrets

```bash
# Telegram Bot Token
npx wrangler secret put BOT_TOKEN
# 粘贴你的 Bot Token

# Webhook 密钥（随机字符串，自己生成）
npx wrangler secret put WEBHOOK_SECRET
# 粘贴一个随机字符串，如：mySecretKey123456

# Turnstile Site Key
npx wrangler secret put TURNSTILE_SITE_KEY
# 粘贴步骤五获取的 Site Key

# Turnstile Secret Key
npx wrangler secret put TURNSTILE_SECRET_KEY
# 粘贴步骤五获取的 Secret Key
```

#### 步骤七：部署

```bash
npx wrangler deploy
```

部署成功后会输出 Worker URL，如 `https://tgbot-d1.你的子域.workers.dev`。

#### 步骤八：绑定自定义域名（可选但推荐）

1. Cloudflare Dashboard → Workers & Pages → 你的 Worker → 设置 → 触发器 → 自定义域
2. 添加自定义域名（需该域名在 Cloudflare 托管）
3. 将 `wrangler.toml` 中的 `APP_BASE_URL` 更新为自定义域名并重新部署

#### 步骤九：设置 Webhook

在浏览器中访问以下 URL 完成设置（替换尖括号内容）：

```
https://api.telegram.org/bot<你的BOT_TOKEN>/setWebhook?url=<你的Worker_URL>/webhook&secret_token=<你的WEBHOOK_SECRET>
```

返回 `{"ok":true,"result":true,"description":"Webhook was set"}` 即成功。

---

### 配置项总览

| 配置项 | 类型 | 说明 |
|---|---|---|
| `BOT_TOKEN` | Secret | Telegram Bot Token |
| `WEBHOOK_SECRET` | Secret | Webhook 验证密钥（随机字符串） |
| `TURNSTILE_SITE_KEY` | Secret | Turnstile 组件 Site Key |
| `TURNSTILE_SECRET_KEY` | Secret | Turnstile 组件 Secret Key |
| `ADMIN_IDS` | Var | 管理员用户 ID，多个用英文逗号分隔 |
| `ADMIN_GROUP_ID` | Var | 管理员超级群组 ID（-100 开头） |
| `APP_BASE_URL` | Var | Worker 的访问地址（用于验证页 URL） |
| `BOT_USERNAME` | Var | Bot 用户名（不带 @） |
| `TG_BOT_DB` | D1 Binding | D1 数据库绑定（必须叫这个名字） |

---

### 数据库表说明

数据库表在首次运行时**自动创建**，无需手动建表。包含以下表：

| 表名 | 用途 |
|---|---|
| `users` | 用户信息、话题 ID、状态、屏蔽计数 |
| `config` | 系统配置（键值对） |
| `messages` | 消息记录（用户ID、消息ID、文本、时间） |
| `processed_updates` | Update 去重记录 |
| `verify_sessions` | 验证会话（session_id、user_id、状态、过期时间） |
| `fingerprints` | 用户指纹记录（Canvas、WebGL、Audio、OS、CPU等） |
| `fingerprint_tags` | 指纹标签（标记可疑指纹） |
| `blacklist` | 黑名单记录 |

---

### 管理员指令

| 指令 | 说明 |
|---|---|
| `/start` | 私聊 Bot 进入配置菜单 |
| `/ban` | 封禁用户 |
| `/unban` | 解禁用户 |
| `/card` | 重建当前话题资料卡 |
| `/card 用户ID` | 重新绑定用户并创建资料卡 |
| `/admin` | 管理员命令（验证审批/拒绝、黑名单、指纹标签） |
| `/cancel` | 取消当前配置编辑操作 |

---

### 常见问题

**Q: 点击验证出现白屏？**
A: Telegram WebView 打开瞬间有短暂白屏是客户端行为。页面 HTML 加载后会立即显示深色背景。如白屏时间过长，检查 Worker 域名是否可访问。

**Q: Turnstile 验证框不显示？**
A: 确认 Turnstile 组件模式是 **Managed**，不是 Invisible。Invisible 模式会静默通过不显示界面。

**Q: 验证失败提示重试？**
A: 检查 `TURNSTILE_SITE_KEY` 和 `TURNSTILE_SECRET_KEY` 是否匹配同一个 Turnstile 组件。

**Q: 私聊 Bot /start 没反应？**
A: 检查 `BOT_TOKEN` 是否正确。

**Q: 回复用户消息没反应？**
A: 检查 `ADMIN_IDS` 是否包含你的用户 ID。

**Q: 配置菜单报 ERROR？**
A: 检查 D1 数据库绑定，变量名必须为 `TG_BOT_DB`。

**Q: 创建话题失败提示无法连接客服？**
A: 三个可能：Bot 提权失败（重新提权）、群组 ID 不对（用 @nmbot 获取）、群组不是超级群组（ID 不 -100 开头则删除重建）。

---

### 项目结构

```
TGbot-D1/
├── src/
│   └── index.js          # 主程序（Hono 框架，Workers 入口）
├── package.json          # 依赖配置
├── wrangler.toml         # Cloudflare Workers 配置
├── .gitignore
└── README.md
```

---

### 技术栈

- **运行环境**：Cloudflare Workers
- **Web 框架**：Hono
- **数据库**：Cloudflare D1 (SQLite)
- **人机验证**：Cloudflare Turnstile
- **Telegram 交互**：原生 fetch（不依赖 telegraf）
- **部署工具**：Wrangler CLI

---

### License

MIT
