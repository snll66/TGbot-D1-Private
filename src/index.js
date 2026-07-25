const USER_STATE = {
  NEW: 'new',
  PENDING: 'pending_verification',
  VERIFIED: 'verified'
};

const DEFAULTS = {
  welcome_msg:
    '在发消息之前，请先完成人机验证，验证完成后即可正常发送消息。',
  verif_q: '',
  verif_a: '3',
  keyword_responses: '[]',
  block_keywords: '[]',
  block_threshold: '5',
  authorized_admins: '[]',

  enable_image_forwarding: 'true',
  enable_link_forwarding: 'true',
  enable_text_forwarding: 'true',
  enable_audio_forwarding: 'true',
  enable_sticker_forwarding: 'true',
  enable_user_forwarding: 'true',
  enable_group_forwarding: 'true',
  enable_channel_forwarding: 'true'
};

const LIMITS = {
  welcome_msg: 4000,
  verif_q: 4000,
  verif_a: 300,
  block_threshold: 3,
  authorized_admins: 2000,
  block_keyword: 200,
  auto_reply_pattern: 200,
  auto_reply_response: 4000,
  filter_text: 5000
};

const ADMIN_STATE_TTL_MS = 10 * 60 * 1000;
const RULE_PAGE_SIZE = 20;
const TOPIC_LOCK_TIMEOUT_SECONDS = 30;
const DATABASE_RETENTION_SECONDS = 90 * 24 * 60 * 60;

const USER_UPDATE_FIELDS = new Set([
  'user_state',
  'is_blocked',
  'is_muted',
  'block_count',
  'topic_id',
  'info_card_message_id',
  'user_info_json',
  'topic_creating',
  'topic_lock_at',
  'created_at',
  'updated_at'
]);

let migrationPromise = null;
let botCommandsPromise = null;

async function ensureBotCommands(env) {
  if (botCommandsPromise) {
    return botCommandsPromise;
  }

  botCommandsPromise = telegramApi(
    env.BOT_TOKEN,
    'setMyCommands',
    {
      commands: [
        {
          command: 'ban',
          description: '封禁当前话题用户'
        },
        {
          command: 'unban',
          description: '解除当前话题用户封禁'
        },
        {
          command: 'delete',
          description: '删除被回复的消息'
        },
        {
          command: 'terminate',
          description: '删除当前用户话题'
        },
        {
          command: 'card',
          description: '重新创建当前用户资料卡'
        },
        {
          command: 'admin',
          description: '管理命令（指纹标签/黑名单）'
        },
        {
          command: 'testverify',
          description: '测试验证流程 /testverify 用户ID'
        },
        {
          command: 'reset',
          description: '重置用户验证 /reset 用户ID'
        }
      ]
    }
  ).catch((error) => {
    botCommandsPromise = null;

    console.error(
      '注册机器人命令失败：',
      error?.message || error
    );
  });

  return botCommandsPromise;
}


/* -------------------------------------------------------------------------- */
/*                               通用辅助函数                                   */
/* -------------------------------------------------------------------------- */

function escapeHtml(text) {
  if (text === null || text === undefined) return '';

  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMessageNotModifiedError(error) {
  return String(error?.message || error)
    .toLowerCase()
    .includes('message is not modified');
}


function toBoolText(value, defaultValue = true) {
  if (typeof value !== 'string') return defaultValue;
  return value.toLowerCase() === 'true';
}

function formatTimestamp(timestamp) {
  // 修复：原代码对 0/空值返回字面量 '[]'，显示不友好
  if (!timestamp) return '未知';

  const date = new Date(Number(timestamp) * 1000);

  if (Number.isNaN(date.getTime())) {
    return '未知';
  }

  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false
  });
}

function randomId() {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function clampPage(page, totalItems) {
  const totalPages = Math.max(
    1,
    Math.ceil(totalItems / RULE_PAGE_SIZE)
  );

  const normalizedPage = Number.isInteger(Number(page))
    ? Number(page)
    : 0;

  return {
    page: Math.max(
      0,
      Math.min(normalizedPage, totalPages - 1)
    ),
    totalPages
  };
}

function hasLinks(message) {
  const entities = [
    ...(message?.entities || []),
    ...(message?.caption_entities || [])
  ];

  return entities.some((entity) => {
    return (
      entity.type === 'url' ||
      entity.type === 'text_link' ||
      entity.type === 'email'
    );
  });
}

function getForwardType(message) {
  const origin = message?.forward_origin;

  if (origin) {
    if (
      origin.type === 'user' ||
      origin.type === 'hidden_user'
    ) {
      return 'user';
    }

    if (origin.type === 'channel') {
      return 'channel';
    }

    if (origin.type === 'chat') {
      const chatType = origin.sender_chat?.type;

      if (chatType === 'channel') {
        return 'channel';
      }

      if (
        chatType === 'group' ||
        chatType === 'supergroup'
      ) {
        return 'group';
      }

      return 'group';
    }
  }

  // 兼容旧版 Telegram Bot API 字段
  if (message?.forward_from_chat?.type === 'channel') {
    return 'channel';
  }

  if (
    message?.forward_from_chat?.type === 'group' ||
    message?.forward_from_chat?.type === 'supergroup'
  ) {
    return 'group';
  }

  if (
    message?.forward_from ||
    message?.forward_sender_name
  ) {
    return 'user';
  }

  return null;
}

function detectMessageKind(message) {
  if (
    message?.photo ||
    message?.video ||
    message?.document ||
    message?.video_note
  ) {
    return 'media';
  }

  if (message?.audio || message?.voice) {
    return 'audio_voice';
  }

  if (message?.sticker || message?.animation) {
    return 'sticker_gif';
  }

  if (message?.text || message?.caption) {
    return 'text';
  }

  return 'other';
}

function getMessageText(message) {
  return String(
    message?.text ||
    message?.caption ||
    ''
  ).slice(0, LIMITS.filter_text);
}

function getMessageStorageKey(direction, messageId) {
  return `${direction}:${messageId}`;
}

function isTopicInvalidError(error) {
  const text = String(error?.message || error).toLowerCase();

  return (
    text.includes('message thread not found') ||
    text.includes('message thread is closed') ||
    text.includes('topic_closed') ||
    text.includes('topic was deleted') ||
    text.includes('forum topic was closed') ||
    text.includes('message thread id is invalid')
  );
}

function validateEnvironment(env) {
  const missing = [];

  if (!env.BOT_TOKEN) missing.push('BOT_TOKEN');
  if (!env.ADMIN_GROUP_ID) missing.push('ADMIN_GROUP_ID');
  if (!env.ADMIN_IDS) missing.push('ADMIN_IDS');
  if (!env.WEBHOOK_SECRET) missing.push('WEBHOOK_SECRET');
  if (!env.TG_BOT_DB) missing.push('TG_BOT_DB');
  if (!env.TURNSTILE_SITE_KEY) missing.push('TURNSTILE_SITE_KEY');
  if (!env.TURNSTILE_SECRET_KEY) missing.push('TURNSTILE_SECRET_KEY');
  if (!env.APP_BASE_URL) missing.push('APP_BASE_URL');

  if (missing.length > 0) {
    throw new Error(
      `缺少环境变量或绑定：${missing.join(', ')}`
    );
  }
}

/* -------------------------------------------------------------------------- */
/*                             Telegram API 封装                               */
/* -------------------------------------------------------------------------- */

async function telegramApi(
  token,
  method,
  params = {},
  attempt = 0
) {
  const url =
    `https://api.telegram.org/bot${token}/${method}`;

  let response;

  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15000)
    });
  } catch (error) {
    if (attempt < 2) {
      await sleep(500 * (attempt + 1));

      return telegramApi(
        token,
        method,
        params,
        attempt + 1
      );
    }

    throw new Error(
      `Telegram 网络请求失败 (${method})：` +
      `${error?.message || error}`
    );
  }

  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error(
      `Telegram API 返回非 JSON 内容 ` +
      `(${method}, HTTP ${response.status})`
    );
  }

  if (!data.ok) {
    const retryAfter = Number(
      data.parameters?.retry_after || 0
    );

    if (
      data.error_code === 429 &&
      retryAfter > 0 &&
      attempt < 2
    ) {
      await sleep(
        Math.min(retryAfter * 1000, 10000)
      );

      return telegramApi(
        token,
        method,
        params,
        attempt + 1
      );
    }

    if (
      response.status >= 500 &&
      attempt < 2
    ) {
      await sleep(500 * (attempt + 1));

      return telegramApi(
        token,
        method,
        params,
        attempt + 1
      );
    }

    const error = new Error(
      data.description ||
      `Telegram API 错误：${method}`
    );

    error.errorCode = data.error_code;
    error.parameters = data.parameters;

    throw error;
  }

  return data.result;
}

/* -------------------------------------------------------------------------- */
/*                                数据库迁移                                    */
/* -------------------------------------------------------------------------- */

async function ensureUserColumn(
  env,
  columnName,
  definition
) {
  const result = await env.TG_BOT_DB.prepare(
    'PRAGMA table_info(users)'
  ).all();

  const columns = result?.results || [];
  const exists = columns.some(
    (column) => column.name === columnName
  );

  if (!exists) {
    await env.TG_BOT_DB.prepare(
      `ALTER TABLE users ADD COLUMN ` +
      `${columnName} ${definition}`
    ).run();
  }
}

async function dbMigrate(env) {
  if (!env.TG_BOT_DB) {
    throw new Error(
      "D1 database binding 'TG_BOT_DB' is missing."
    );
  }

  const queries = [
    `
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    )
    `,
    `
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY NOT NULL,
      user_state TEXT NOT NULL DEFAULT 'new',
      is_blocked INTEGER NOT NULL DEFAULT 0,
      is_muted INTEGER NOT NULL DEFAULT 0,
      block_count INTEGER NOT NULL DEFAULT 0,
      topic_id TEXT,
      info_card_message_id TEXT,
      user_info_json TEXT,
      topic_creating INTEGER NOT NULL DEFAULT 0,
      topic_lock_at INTEGER,
      created_at INTEGER,
      updated_at INTEGER
    )
    `,
    `
    CREATE TABLE IF NOT EXISTS messages (
      user_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      text TEXT,
      date INTEGER,
      PRIMARY KEY (user_id, message_id)
    )
    `,
    `
    CREATE TABLE IF NOT EXISTS processed_updates (
      update_id TEXT PRIMARY KEY NOT NULL,
      processed_at INTEGER NOT NULL
    )
    `,
    `
    CREATE TABLE IF NOT EXISTS verify_sessions (
      session_id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      fingerprint_id INTEGER,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
    `,
    `
    CREATE TABLE IF NOT EXISTS fingerprints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      session_id TEXT,
      pub_ip TEXT,
      pub_asn TEXT,
      pub_isp TEXT,
      webrtc_ip TEXT,
      webrtc_asn TEXT,
      webrtc_isp TEXT,
      device_json TEXT,
      device_hash TEXT,
      created_at INTEGER NOT NULL
    )
    `,
    `
    CREATE TABLE IF NOT EXISTS fingerprint_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fingerprint_id INTEGER NOT NULL,
      tag TEXT NOT NULL,
      note TEXT,
      created_at INTEGER NOT NULL
    )
    `,
    `
    CREATE TABLE IF NOT EXISTS blacklist (
      user_id TEXT PRIMARY KEY NOT NULL,
      reason TEXT,
      source TEXT,
      created_at INTEGER NOT NULL
    )
    `,
    `
    CREATE TABLE IF NOT EXISTS banned_ips (
      ip TEXT PRIMARY KEY NOT NULL,
      reason TEXT,
      created_at INTEGER NOT NULL
    )
    `,
    `
    CREATE INDEX IF NOT EXISTS idx_users_topic_id
    ON users(topic_id)
    `,
    `
    CREATE INDEX IF NOT EXISTS idx_messages_date
    ON messages(date)
    `,
    `
    CREATE INDEX IF NOT EXISTS idx_processed_updates_time
    ON processed_updates(processed_at)
    `,
    `
    CREATE INDEX IF NOT EXISTS idx_verify_sessions_user
    ON verify_sessions(user_id)
    `,
    `
    CREATE INDEX IF NOT EXISTS idx_fingerprints_user
    ON fingerprints(user_id)
    `,
    `
    CREATE INDEX IF NOT EXISTS idx_fingerprints_user_hash
    ON fingerprints(user_id, device_hash)
    `,
    `
    CREATE INDEX IF NOT EXISTS idx_fingerprint_tags_fp
    ON fingerprint_tags(fingerprint_id)
    `
  ];

  await env.TG_BOT_DB.batch(
    queries.map((query) =>
      env.TG_BOT_DB.prepare(query)
    )
  );

  // 兼容旧数据库结构
  await ensureUserColumn(
    env,
    'topic_creating',
    'INTEGER NOT NULL DEFAULT 0'
  );

  await ensureUserColumn(
    env,
    'topic_lock_at',
    'INTEGER'
  );

  // 指纹去重：清理同一 user_id 的重复记录，只保留最新一条（id 最大）
  // 然后创建唯一索引，从数据库层面杜绝重复
  try {
    await env.TG_BOT_DB.prepare(
      `DELETE FROM fingerprints
       WHERE id NOT IN (
         SELECT MAX(id) FROM fingerprints GROUP BY user_id
       )`
    ).run();
  } catch (e) {
    console.error('清理重复指纹失败：', e?.message || e);
  }

  try {
    await env.TG_BOT_DB.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_fingerprints_user_unique
       ON fingerprints(user_id)`
    ).run();
  } catch (e) {
    console.error('创建指纹唯一索引失败：', e?.message || e);
  }
}

async function ensureMigration(env) {
  if (!migrationPromise) {
    migrationPromise = dbMigrate(env).catch((error) => {
      migrationPromise = null;
      throw error;
    });
  }

  return migrationPromise;
}

/* -------------------------------------------------------------------------- */
/*                    指纹采集与相似度匹配（静默，用户无感知）                      */
/* -------------------------------------------------------------------------- */

const SIMILARITY_THRESHOLD = 0.6;

function genSessionId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = [...bytes]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return (
    hex.slice(0, 8) + '-' +
    hex.slice(8, 12) + '-' +
    hex.slice(12, 16) + '-' +
    hex.slice(16, 20) + '-' +
    hex.slice(20)
  );
}

function djb2(str) {
  let hash = 5381n;
  for (let i = 0; i < str.length; i++) {
    hash =
      ((hash << 5n) + hash +
        BigInt(str.charCodeAt(i))) &
      0xffffffffn;
  }
  return hash.toString(16).padStart(8, '0');
}

function normalizeDeviceHash(signals) {
  const keys = [
    'canvas',
    'webgl',
    'audio',
    'os',
    'cpu',
    'screen',
    'fonts'
  ];
  const parts = keys.map(
    (k) => `${k}:${signals[k] ?? ''}`
  );
  return djb2(parts.join('|'));
}

function stringSimilarity(a, b) {
  if (a == null) a = '';
  if (b == null) b = '';
  a = String(a).trim().toLowerCase();
  b = String(b).trim().toLowerCase();
  if (a === b) return 1;
  if (!a || !b) return 0;

  const n = 3;
  const gramsA = new Set();
  const gramsB = new Set();
  for (let i = 0; i <= a.length - n; i++)
    gramsA.add(a.slice(i, i + n));
  for (let i = 0; i <= b.length - n; i++)
    gramsB.add(b.slice(i, i + n));

  if (gramsA.size === 0 || gramsB.size === 0) {
    const minLen = Math.min(
      a.length,
      b.length
    );
    let same = 0;
    for (let i = 0; i < minLen; i++)
      if (a[i] === b[i]) same++;
    return minLen
      ? same / Math.max(a.length, b.length)
      : 0;
  }

  let inter = 0;
  for (const g of gramsA)
    if (gramsB.has(g)) inter++;
  return (
    inter /
    (gramsA.size + gramsB.size - inter)
  );
}

function deviceSimilarity(devA, devB) {
  const keys = [
    'canvas',
    'webgl',
    'audio',
    'os',
    'cpu',
    'screen',
    'fonts'
  ];
  let sum = 0;
  for (const k of keys)
    sum += stringSimilarity(
      devA?.[k],
      devB?.[k]
    );
  return sum / keys.length;
}

function networkSimilarity(fpA, fpB) {
  const fields = [
    'pub_ip',
    'pub_asn',
    'pub_isp',
    'webrtc_ip',
    'webrtc_asn',
    'webrtc_isp'
  ];
  let sum = 0;
  for (const f of fields) {
    const a = fpA?.[f];
    const b = fpB?.[f];
    if (
      f.endsWith('_ip') ||
      f.endsWith('_asn')
    ) {
      sum +=
        a && b && String(a) === String(b)
          ? 1
          : 0;
    } else {
      sum += stringSimilarity(a, b);
    }
  }
  return sum / fields.length;
}

function overallSimilarity(fpA, fpB) {
  let devA = {};
  let devB = {};
  try {
    devA = JSON.parse(
      fpA.device_json || '{}'
    );
  } catch {}
  try {
    devB = JSON.parse(
      fpB.device_json || '{}'
    );
  } catch {}
  const net = networkSimilarity(fpA, fpB);
  const dev = deviceSimilarity(devA, devB);
  return 0.5 * net + 0.5 * dev;
}

async function findSimilarFingerprints(
  db,
  targetFp,
  threshold = SIMILARITY_THRESHOLD
) {
  const { results: candidates } =
    await db
      .prepare(
        'SELECT * FROM fingerprints ORDER BY created_at DESC LIMIT ?'
      )
      .bind(500)
      .all();

  const hits = [];
  for (const fp of candidates) {
    if (fp.id === targetFp.id) continue;
    const sim = overallSimilarity(
      targetFp,
      fp
    );
    if (sim >= threshold) {
      hits.push({
        fingerprint: fp,
        similarity: sim
      });
    }
  }

  if (!hits.length) return [];

  hits.sort(
    (a, b) => b.similarity - a.similarity
  );

  const fpIds = hits.map(
    (h) => h.fingerprint.id
  );
  const placeholders = fpIds
    .map(() => '?')
    .join(',');
  const { results: allTags } = await db
    .prepare(
      `SELECT * FROM fingerprint_tags WHERE fingerprint_id IN (${placeholders})`
    )
    .bind(...fpIds)
    .all();

  const tagMap = new Map();
  for (const t of allTags) {
    if (!tagMap.has(t.fingerprint_id))
      tagMap.set(t.fingerprint_id, []);
    tagMap.get(t.fingerprint_id).push(t);
  }

  return hits
    .map((h) => ({
      ...h,
      tags:
        tagMap.get(h.fingerprint.id) || []
    }))
    .filter((h) => h.tags.length > 0);
}

/* ---------- 指纹 / 验证会话 DB 操作 ---------- */

// 列出最近的指纹记录（含标签）
async function listFingerprints(
  env,
  limit = 20
) {
  const { results: fingerprints } =
    await env.TG_BOT_DB.prepare(
      'SELECT * FROM fingerprints ORDER BY created_at DESC LIMIT ?'
    )
      .bind(limit)
      .all();

  if (!fingerprints.length) return [];

  const fpIds = fingerprints.map((f) => f.id);
  const placeholders = fpIds
    .map(() => '?')
    .join(',');
  const { results: allTags } =
    await env.TG_BOT_DB.prepare(
      `SELECT * FROM fingerprint_tags WHERE fingerprint_id IN (${placeholders})`
    )
      .bind(...fpIds)
      .all();

  const tagMap = new Map();
  for (const t of allTags) {
    if (!tagMap.has(t.fingerprint_id))
      tagMap.set(t.fingerprint_id, []);
    tagMap.get(t.fingerprint_id).push(t);
  }

  // 批量查询关联用户信息（昵称、用户名）
  const userIds = [
    ...new Set(
      fingerprints.map((f) => f.user_id)
    )
  ];
  const userPlaceholders = userIds
    .map(() => '?')
    .join(',');
  const { results: users } =
    await env.TG_BOT_DB.prepare(
      `SELECT user_id, user_info_json FROM users WHERE user_id IN (${userPlaceholders})`
    )
      .bind(...userIds)
      .all();

  const userMap = new Map();
  for (const u of users) {
    let info = null;
    try {
      info = u.user_info_json
        ? JSON.parse(u.user_info_json)
        : null;
    } catch {}
    userMap.set(u.user_id, info || {});
  }

  return fingerprints.map((f) => ({
    fingerprint: f,
    tags: tagMap.get(f.id) || [],
    userInfo: userMap.get(f.user_id) || {}
  }));
}

async function dbCreateVerifySession(
  env,
  sessionId,
  userId,
  ttlMinutes
) {
  const now = Math.floor(
    Date.now() / 1000
  );
  await env.TG_BOT_DB.prepare(
    `INSERT INTO verify_sessions (session_id, user_id, status, created_at, expires_at)
     VALUES (?, ?, 'pending', ?, ?)`
  )
    .bind(
      sessionId,
      userId,
      now,
      now + ttlMinutes * 60
    )
    .run();
}

async function dbGetVerifySession(
  env,
  sessionId
) {
  return env.TG_BOT_DB.prepare(
    'SELECT * FROM verify_sessions WHERE session_id = ?'
  )
    .bind(sessionId)
    .first();
}

async function dbUpdateVerifySession(
  env,
  sessionId,
  status,
  fingerprintId
) {
  await env.TG_BOT_DB.prepare(
    'UPDATE verify_sessions SET status = ?, fingerprint_id = ? WHERE session_id = ?'
  )
    .bind(
      status,
      fingerprintId ?? null,
      sessionId
    )
    .run();
}

async function dbInsertFingerprint(
  env,
  data
) {
  const now = Math.floor(
    Date.now() / 1000
  );

  // 原子 upsert：依赖 user_id 唯一索引，同一用户只保留一条指纹记录
  // 彻底解决并发请求导致的重复插入问题（SELECT-then-INSERT 有竞态）
  const row = await env.TG_BOT_DB.prepare(
    `INSERT INTO fingerprints
       (user_id, session_id, pub_ip, pub_asn, pub_isp,
        webrtc_ip, webrtc_asn, webrtc_isp, device_json, device_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       session_id = excluded.session_id,
       pub_ip = excluded.pub_ip,
       pub_asn = excluded.pub_asn,
       pub_isp = excluded.pub_isp,
       webrtc_ip = excluded.webrtc_ip,
       webrtc_asn = excluded.webrtc_asn,
       webrtc_isp = excluded.webrtc_isp,
       device_json = excluded.device_json,
       device_hash = excluded.device_hash,
       created_at = excluded.created_at
     RETURNING id`
  )
    .bind(
      String(data.user_id),
      data.session_id,
      data.pub_ip ?? null,
      data.pub_asn ?? null,
      data.pub_isp ?? null,
      data.webrtc_ip ?? null,
      data.webrtc_asn ?? null,
      data.webrtc_isp ?? null,
      data.device_json,
      data.device_hash,
      now
    )
    .first();

  return row?.id || null;
}

async function dbGetLatestFingerprint(
  env,
  userId
) {
  return env.TG_BOT_DB.prepare(
    'SELECT * FROM fingerprints WHERE user_id = ? ORDER BY created_at DESC LIMIT 1'
  )
    .bind(userId)
    .first();
}

async function dbAddFingerprintTag(
  env,
  fingerprintId,
  tag,
  note
) {
  const now = Math.floor(
    Date.now() / 1000
  );
  await env.TG_BOT_DB.prepare(
    'INSERT INTO fingerprint_tags (fingerprint_id, tag, note, created_at) VALUES (?, ?, ?, ?)'
  )
    .bind(
      fingerprintId,
      tag,
      note ?? null,
      now
    )
    .run();
}

async function dbGetFingerprintTags(
  env,
  fingerprintId
) {
  const { results } = await env.TG_BOT_DB
    .prepare(
      'SELECT * FROM fingerprint_tags WHERE fingerprint_id = ? ORDER BY id DESC'
    )
    .bind(fingerprintId)
    .all();
  return results;
}

async function dbDeleteFingerprintTag(
  env,
  tagId
) {
  await env.TG_BOT_DB.prepare(
    'DELETE FROM fingerprint_tags WHERE id = ?'
  )
    .bind(tagId)
    .run();
}

async function dbGetFingerprintById(
  env,
  fpId
) {
  return env.TG_BOT_DB.prepare(
    'SELECT * FROM fingerprints WHERE id = ?'
  )
    .bind(fpId)
    .first();
}

/* ---------- 黑名单 DB 操作 ---------- */

async function dbBlacklistAdd(
  env,
  userId,
  reason = '',
  source = 'manual'
) {
  const now = Math.floor(Date.now() / 1000);
  await env.TG_BOT_DB.prepare(
    `INSERT INTO blacklist (user_id, reason, source, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id)
     DO UPDATE SET reason = excluded.reason,
                   source = excluded.source,
                   created_at = excluded.created_at`
  )
    .bind(String(userId), reason, source, now)
    .run();
}

async function dbBlacklistRemove(env, userId) {
  await env.TG_BOT_DB.prepare(
    'DELETE FROM blacklist WHERE user_id = ?'
  )
    .bind(String(userId))
    .run();
}

async function dbBlacklistList(env, limit = 50) {
  const { results } = await env.TG_BOT_DB.prepare(
    'SELECT * FROM blacklist ORDER BY created_at DESC LIMIT ?'
  )
    .bind(limit)
    .all();
  return results || [];
}

async function dbIsBlacklisted(env, userId) {
  const row = await env.TG_BOT_DB.prepare(
    'SELECT 1 FROM blacklist WHERE user_id = ?'
  )
    .bind(String(userId))
    .first();
  return Boolean(row);
}

/* -------------------------- 封禁 IP 管理 -------------------------- */

async function dbBannedIpAdd(
  env,
  ip,
  reason = ''
) {
  const now = Math.floor(
    Date.now() / 1000
  );
  await env.TG_BOT_DB.prepare(
    `INSERT INTO banned_ips (ip, reason, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(ip)
     DO UPDATE SET reason = excluded.reason,
                   created_at = excluded.created_at`
  )
    .bind(
      String(ip).trim(),
      reason,
      now
    )
    .run();
}

async function dbBannedIpRemove(env, ip) {
  await env.TG_BOT_DB.prepare(
    'DELETE FROM banned_ips WHERE ip = ?'
  )
    .bind(String(ip).trim())
    .run();
}

async function dbBannedIpList(
  env,
  limit = 100
) {
  const { results } =
    await env.TG_BOT_DB.prepare(
      'SELECT * FROM banned_ips ORDER BY created_at DESC LIMIT ?'
    )
      .bind(limit)
      .all();
  return results || [];
}

async function dbIsIpBanned(env, ip) {
  if (!ip) return false;
  const row =
    await env.TG_BOT_DB.prepare(
      'SELECT 1 FROM banned_ips WHERE ip = ?'
    )
      .bind(String(ip).trim())
      .first();
  return Boolean(row);
}

async function cleanupDatabase(env) {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - DATABASE_RETENTION_SECONDS;

  try {
    await env.TG_BOT_DB.batch([
      env.TG_BOT_DB.prepare(
        'DELETE FROM messages WHERE date < ?'
      ).bind(cutoff),

      env.TG_BOT_DB.prepare(
        'DELETE FROM processed_updates ' +
        'WHERE processed_at < ?'
      ).bind(cutoff)
    ]);
  } catch (error) {
    console.error(
      '清理数据库失败：',
      error?.message || error
    );
  }
}

async function claimUpdate(updateId, env) {
  if (
    updateId === null ||
    updateId === undefined
  ) {
    return true;
  }

  const result = await env.TG_BOT_DB.prepare(`
    INSERT OR IGNORE INTO processed_updates (
      update_id,
      processed_at
    ) VALUES (?, ?)
  `).bind(
    String(updateId),
    Math.floor(Date.now() / 1000)
  ).run();

  return Number(result?.meta?.changes || 0) > 0;
}

/* -------------------------------------------------------------------------- */
/*                               配置数据库操作                                  */
/* -------------------------------------------------------------------------- */

async function dbConfigGet(key, env) {
  const row = await env.TG_BOT_DB.prepare(
    'SELECT value FROM config WHERE key = ?'
  ).bind(key).first();

  return row ? row.value : null;
}

async function dbConfigPut(key, value, env) {
  await env.TG_BOT_DB.prepare(`
    INSERT INTO config (key, value)
    VALUES (?, ?)
    ON CONFLICT(key)
    DO UPDATE SET value = excluded.value
  `).bind(key, String(value)).run();
}

async function dbConfigDelete(key, env) {
  await env.TG_BOT_DB.prepare(
    'DELETE FROM config WHERE key = ?'
  ).bind(key).run();
}

async function getConfig(
  key,
  env,
  defaultValue = ''
) {
  const value = await dbConfigGet(key, env);

  if (value !== null) {
    return value;
  }

  if (DEFAULTS[key] !== undefined) {
    return DEFAULTS[key];
  }

  return defaultValue;
}

async function setConfig(key, value, env) {
  await dbConfigPut(key, value, env);
}

/* -------------------------------------------------------------------------- */
/*                                用户数据库操作                                 */
/* -------------------------------------------------------------------------- */

function normalizeUser(user) {
  if (!user) return null;

  return {
    ...user,
    is_blocked: Number(user.is_blocked) === 1,
    is_muted: Number(user.is_muted) === 1,
    topic_creating:
      Number(user.topic_creating) === 1,
    user_info: user.user_info_json
      ? safeJsonParse(user.user_info_json, null)
      : null
  };
}

async function dbUserGet(userId, env) {
  const row = await env.TG_BOT_DB.prepare(
    'SELECT * FROM users WHERE user_id = ?'
  ).bind(String(userId)).first();

  return normalizeUser(row);
}

async function dbUserGetOrCreate(userId, env) {
  const normalizedId = String(userId);
  const now = Math.floor(Date.now() / 1000);

  await env.TG_BOT_DB.prepare(`
    INSERT OR IGNORE INTO users (
      user_id,
      user_state,
      is_blocked,
      is_muted,
      block_count,
      topic_creating,
      created_at,
      updated_at
    ) VALUES (?, ?, 0, 0, 0, 0, ?, ?)
  `).bind(
    normalizedId,
    USER_STATE.NEW,
    now,
    now
  ).run();

  return dbUserGet(normalizedId, env);
}

async function dbUserUpdate(userId, data, env) {
  if (
    !data ||
    Object.keys(data).length === 0
  ) {
    return;
  }

  const payload = {
    ...data,
    updated_at: Math.floor(Date.now() / 1000)
  };

  if (payload.user_info !== undefined) {
    payload.user_info_json =
      payload.user_info === null
        ? null
        : JSON.stringify(payload.user_info);

    delete payload.user_info;
  }

  const keys = Object.keys(payload).filter(
    (key) => USER_UPDATE_FIELDS.has(key)
  );

  if (keys.length === 0) {
    return;
  }

  const fields = keys
    .map((key) => `${key} = ?`)
    .join(', ');

  const values = keys.map((key) => {
    const value = payload[key];

    if (
      key === 'is_blocked' ||
      key === 'is_muted' ||
      key === 'topic_creating'
    ) {
      if (typeof value === 'boolean') {
        return value ? 1 : 0;
      }
    }

    return value;
  });

  await env.TG_BOT_DB.prepare(
    `UPDATE users SET ${fields} WHERE user_id = ?`
  ).bind(
    ...values,
    String(userId)
  ).run();
}

async function dbTopicUserGet(topicId, env) {
  const row = await env.TG_BOT_DB.prepare(
    'SELECT user_id FROM users WHERE topic_id = ?'
  ).bind(String(topicId)).first();

  return row ? row.user_id : null;
}

async function incrementBlockCount(
  userId,
  threshold,
  env
) {
  await env.TG_BOT_DB.prepare(`
    UPDATE users
    SET
      block_count = block_count + 1,
      is_blocked = CASE
        WHEN block_count + 1 >= ? THEN 1
        ELSE is_blocked
      END,
      updated_at = ?
    WHERE user_id = ?
  `).bind(
    threshold,
    Math.floor(Date.now() / 1000),
    String(userId)
  ).run();

  const user = await dbUserGetOrCreate(userId, env);

  return {
    currentCount: Number(user.block_count || 0),
    shouldAutoBlock:
      Number(user.block_count || 0) >= threshold,
    isBlocked: user.is_blocked
  };
}

/* -------------------------------------------------------------------------- */
/*                               消息记录数据库                                  */
/* -------------------------------------------------------------------------- */

async function dbMessageDataPut(
  userId,
  messageId,
  data,
  env
) {
  await env.TG_BOT_DB.prepare(`
    INSERT INTO messages (
      user_id,
      message_id,
      text,
      date
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, message_id)
    DO UPDATE SET
      text = excluded.text,
      date = excluded.date
  `).bind(
    String(userId),
    String(messageId),
    data?.text || '',
    data?.date || null
  ).run();
}

async function dbMessageDataGet(
  userId,
  messageId,
  env
) {
  const row = await env.TG_BOT_DB.prepare(`
    SELECT text, date
    FROM messages
    WHERE user_id = ?
      AND message_id = ?
  `).bind(
    String(userId),
    String(messageId)
  ).first();

  return row || null;
}

/* -------------------------------------------------------------------------- */
/*                               管理员权限管理                                  */
/* -------------------------------------------------------------------------- */

function getPrimaryAdminIds(env) {
  if (!env.ADMIN_IDS) return [];

  return env.ADMIN_IDS
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

function isPrimaryAdmin(userId, env) {
  return getPrimaryAdminIds(env).includes(
    String(userId)
  );
}

async function getAuthorizedAdmins(env) {
  const raw = await getConfig(
    'authorized_admins',
    env,
    '[]'
  );

  const list = safeJsonParse(raw, []);

  if (!Array.isArray(list)) {
    return [];
  }

  return list
    .map((value) => String(value).trim())
    .filter((value) => /^\d+$/.test(value));
}

async function isAdminUser(userId, env) {
  if (isPrimaryAdmin(userId, env)) {
    return true;
  }

  const admins = await getAuthorizedAdmins(env);

  return admins.includes(String(userId));
}

/* -------------------------------------------------------------------------- */
/*                             管理员输入状态管理                                 */
/* -------------------------------------------------------------------------- */

async function getAdminState(userId, env) {
  const raw = await dbConfigGet(
    `admin_state:${userId}`,
    env
  );

  if (!raw) return null;

  const state = safeJsonParse(raw, null);

  if (!state || typeof state !== 'object') {
    await clearAdminState(userId, env);
    return null;
  }

  if (
    !state.createdAt ||
    Date.now() - Number(state.createdAt) >
      ADMIN_STATE_TTL_MS
  ) {
    await clearAdminState(userId, env);
    return null;
  }

  return state;
}

async function setAdminState(userId, state, env) {
  await dbConfigPut(
    `admin_state:${userId}`,
    JSON.stringify({
      ...state,
      createdAt: Date.now()
    }),
    env
  );
}

async function clearAdminState(userId, env) {
  await dbConfigDelete(
    `admin_state:${userId}`,
    env
  );
}

/* -------------------------------------------------------------------------- */
/*                              正则及过滤规则                                   */
/* -------------------------------------------------------------------------- */

function mergeRegexFlags(...groups) {
  // 禁止 g/y，避免 test() 状态化。
  const allowed = 'imsuv';
  let merged = '';

  for (const group of groups) {
    for (const flag of String(group || '')) {
      if (
        allowed.includes(flag) &&
        !merged.includes(flag)
      ) {
        merged += flag;
      }
    }
  }

  // u 和 v 不能同时使用
  if (
    merged.includes('u') &&
    merged.includes('v')
  ) {
    merged = merged.replace('v', '');
  }

  return merged;
}

function looksDangerousRegex(source) {
  // 只能防住部分常见灾难性回溯，不是完整正则分析器。
  const nestedQuantifier =
    /(\([^)]*[+*][^)]*\))[+*{]/;

  const repeatedWildcard =
    /(\.\*|\.\+).*(\.\*|\.\+)/;

  return (
    nestedQuantifier.test(source) ||
    repeatedWildcard.test(source)
  );
}

function buildRegexRule(
  pattern,
  defaultFlags = 'i'
) {
  let source = String(pattern || '').trim();
  let flags = defaultFlags;

  if (!source) {
    throw new Error('表达式不能为空');
  }

  if (
    source.length >
    LIMITS.auto_reply_pattern
  ) {
    throw new Error(
      `表达式不能超过 ` +
      `${LIMITS.auto_reply_pattern} 个字符`
    );
  }

  const literalMatch = source.match(
    /^\/([\s\S]*)\/([a-z]*)$/i
  );

  if (literalMatch) {
    source = literalMatch[1];
    flags = mergeRegexFlags(
      defaultFlags,
      literalMatch[2]
    );
  }

  const inlineFlagsMatch = source.match(
    /^\(\?([a-z]+)\)/i
  );

  if (inlineFlagsMatch) {
    flags = mergeRegexFlags(
      flags,
      inlineFlagsMatch[1].toLowerCase()
    );

    source = source.slice(
      inlineFlagsMatch[0].length
    );
  }

  if (!source) {
    throw new Error('正则表达式内容不能为空');
  }

  if (looksDangerousRegex(source)) {
    throw new Error(
      '表达式可能造成严重性能问题，请简化正则'
    );
  }

  return new RegExp(source, flags);
}

function validateRegexPattern(pattern) {
  buildRegexRule(pattern);
}

async function getAutoReplyRules(env) {
  const raw = await getConfig(
    'keyword_responses',
    env,
    '[]'
  );

  const rules = safeJsonParse(raw, []);

  return Array.isArray(rules)
    ? rules.filter(
        (rule) =>
          rule &&
          typeof rule === 'object' &&
          rule.keywords !== undefined
      )
    : [];
}

async function getBlockKeywords(env) {
  const raw = await getConfig(
    'block_keywords',
    env,
    '[]'
  );

  const keywords = safeJsonParse(raw, []);

  return Array.isArray(keywords)
    ? keywords.map(String)
    : [];
}

async function getBlockThreshold(env) {
  const raw = await getConfig(
    'block_threshold',
    env,
    '5'
  );

  const threshold = Number(raw);

  if (
    !Number.isInteger(threshold) ||
    threshold < 1 ||
    threshold > 100
  ) {
    return 5;
  }

  return threshold;
}

async function findBlockKeyword(text, env) {
  if (!text) return null;

  const keywords = await getBlockKeywords(env);
  const safeText = String(text).slice(
    0,
    LIMITS.filter_text
  );

  for (const keyword of keywords) {
    try {
      const regex = buildRegexRule(keyword);

      if (regex.test(safeText)) {
        return keyword;
      }
    } catch (error) {
      console.error(
        '无效屏蔽关键词正则：',
        keyword,
        error?.message || error
      );
    }
  }

  return null;
}

async function matchAutoReply(text, env) {
  if (!text) return null;

  const rules = await getAutoReplyRules(env);
  const safeText = String(text).slice(
    0,
    LIMITS.filter_text
  );

  for (const rule of rules) {
    try {
      const regex = buildRegexRule(
        rule.keywords
      );

      if (regex.test(safeText)) {
        return rule.response || null;
      }
    } catch (error) {
      console.error(
        '自动回复规则错误：',
        rule,
        error?.message || error
      );
    }
  }

  return null;
}

async function getFilterConfig(env) {
  return {
    media: toBoolText(
      await getConfig(
        'enable_image_forwarding',
        env,
        'true'
      )
    ),
    link: toBoolText(
      await getConfig(
        'enable_link_forwarding',
        env,
        'true'
      )
    ),
    text: toBoolText(
      await getConfig(
        'enable_text_forwarding',
        env,
        'true'
      )
    ),
    audio_voice: toBoolText(
      await getConfig(
        'enable_audio_forwarding',
        env,
        'true'
      )
    ),
    sticker_gif: toBoolText(
      await getConfig(
        'enable_sticker_forwarding',
        env,
        'true'
      )
    ),
    user_forward: toBoolText(
      await getConfig(
        'enable_user_forwarding',
        env,
        'true'
      )
    ),
    group_forward: toBoolText(
      await getConfig(
        'enable_group_forwarding',
        env,
        'true'
      )
    ),
    channel_forward: toBoolText(
      await getConfig(
        'enable_channel_forwarding',
        env,
        'true'
      )
    )
  };
}

async function checkForwardFilters(message, env) {
  const filters = await getFilterConfig(env);
  const kind = detectMessageKind(message);
  const forwardType = getForwardType(message);

  if (kind === 'media' && !filters.media) {
    return {
      ok: false,
      reason: '当前不允许发送图片、视频或文件。'
    };
  }

  if (
    kind === 'audio_voice' &&
    !filters.audio_voice
  ) {
    return {
      ok: false,
      reason: '当前不允许发送语音或音频。'
    };
  }

  if (
    kind === 'sticker_gif' &&
    !filters.sticker_gif
  ) {
    return {
      ok: false,
      reason: '当前不允许发送贴纸或 GIF。'
    };
  }

  if (kind === 'text' && !filters.text) {
    return {
      ok: false,
      reason: '当前不允许发送文本。'
    };
  }

  if (hasLinks(message) && !filters.link) {
    return {
      ok: false,
      reason: '当前不允许发送链接。'
    };
  }

  if (
    forwardType === 'user' &&
    !filters.user_forward
  ) {
    return {
      ok: false,
      reason: '当前不允许转发来自用户的消息。'
    };
  }

  if (
    forwardType === 'group' &&
    !filters.group_forward
  ) {
    return {
      ok: false,
      reason: '当前不允许转发来自群组的消息。'
    };
  }

  if (
    forwardType === 'channel' &&
    !filters.channel_forward
  ) {
    return {
      ok: false,
      reason: '当前不允许转发来自频道的消息。'
    };
  }

  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/*                             用户资料卡与话题                                  */
/* -------------------------------------------------------------------------- */

function buildUserInfoPayload(
  from,
  firstMessageDate = null,
  fingerprintHtml = ''
) {
  const userId = String(from.id);
  const firstName = from.first_name || '';
  const lastName = from.last_name || '';

  const displayName = (
    `${firstName}` +
    `${lastName ? ` ${lastName}` : ''}`
  ).trim() || '未知用户';

  const usernameRaw = from.username || '';

  const usernameDisplay = usernameRaw
    ? `@${usernameRaw}`
    : '无';

  const topicName = (
    `${displayName} (${userId})`
  ).slice(0, 128);

  const clickableName =
    `<a href="tg://user?id=${userId}">` +
    `${escapeHtml(displayName)}</a>`;

  const usernameText = usernameRaw
    ? `<a href="https://t.me/` +
      `${encodeURIComponent(usernameRaw)}">` +
      `@${escapeHtml(usernameRaw)}</a>`
    : '无';

  const firstTimeText = firstMessageDate
    ? `<b>首次消息时间:</b> ` +
      `<code>${escapeHtml(
        formatTimestamp(firstMessageDate)
      )}</code>`
    : '';

  const fpSection = fingerprintHtml
    ? `\n${fingerprintHtml}`
    : '';

  const infoCard = `
👤 <b>用户资料卡</b>
<b>姓名:</b> ${clickableName}
<b>用户名:</b> ${usernameText}
<b>ID:</b> <code>${escapeHtml(userId)}</code>
${firstTimeText}${fpSection}
  `.trim();

  return {
    userId,
    displayName,
    usernameRaw,
    usernameDisplay,
    topicName,
    infoCard
  };
}

async function buildFingerprintHtml(
  env,
  userId
) {
  const fp = await dbGetLatestFingerprint(
    env,
    String(userId)
  );

  if (!fp) return '';

  let dev = {};
  try {
    dev = JSON.parse(
      fp.device_json || '{}'
    );
  } catch {}

  const lines = [
    '',
    '🖥 <b>设备指纹</b>',
    `<b>系统:</b> ${escapeHtml(dev.os || 'N/A')}`,
    `<b>CPU:</b> ${escapeHtml(dev.cpu || 'N/A')}`,
    `<b>屏幕:</b> ${escapeHtml(dev.screen || 'N/A')}`,
    `<b>公网 IP:</b> <code>${escapeHtml(fp.pub_ip || 'N/A')}</code>`,
    `<b>ASN/ISP:</b> ${escapeHtml(fp.pub_asn || 'N/A')} / ${escapeHtml(fp.pub_isp || 'N/A')}`,
    `<b>WebRTC IP:</b> <code>${escapeHtml(fp.webrtc_ip || 'N/A')}</code>`,
    `<b>指纹 ID:</b> <code>${fp.id}</code>`
  ];

  try {
    const similar =
      await findSimilarFingerprints(
        env.TG_BOT_DB,
        fp
      );
    if (similar.length) {
      lines.push('');
      lines.push(
        '⚠️ <b>相似指纹命中</b>'
      );
      for (const h of similar.slice(0, 3)) {
        const tags = h.tags
          .map((t) => escapeHtml(t.tag))
          .join(', ');
        lines.push(
          `相似度 ${(h.similarity * 100).toFixed(0)}% — 标签：${tags}`
        );
      }
    }
  } catch (e) {
    console.error(
      '指纹相似度匹配失败：',
      e?.message || e
    );
  }

  return lines.join('\n');
}

function getProfileUrl(usernameRaw) {
  const username = String(
    usernameRaw || ''
  ).trim();

  if (
    !/^[A-Za-z0-9_]{5,32}$/.test(username)
  ) {
    return null;
  }

  return (
    `https://t.me/` +
    encodeURIComponent(username)
  );
}

function getInfoCardButtons(
  userId,
  isBlocked,
  isMuted,
  usernameRaw = ''
) {
  const rows = [
    [
      {
        text: isBlocked
          ? '✅ 解除屏蔽'
          : '🚫 屏蔽用户',
        callback_data:
          `${isBlocked ? 'unblock' : 'block'}:` +
          `${userId}`
      },
      {
        text: isMuted
          ? '🔔 恢复通知'
          : '🔕 静音通知',
        callback_data:
          `${isMuted ? 'unmute' : 'mute'}:` +
          `${userId}`
      }
    ],
    [
      {
        text: '📌 置顶资料卡',
        callback_data: `pin_card:${userId}`
      },
      {
        text: '🔄 刷新资料卡',
        callback_data:
          `refresh_card:${userId}`
      }
    ]
  ];

  const profileUrl =
    getProfileUrl(usernameRaw);

  /*
   * 只有用户具有有效公开用户名时，
   * 才显示“查看资料”按钮。
   *
   * 不再使用 tg://user?id=... 作为按钮链接，
   * 避免 BUTTON_USER_PRIVACY_RESTRICTED。
   */
  if (profileUrl) {
    rows.push([
      {
        text: '👤 查看资料',
        url: profileUrl
      }
    ]);
  }

  return {
    inline_keyboard: rows
  };
}


function buildCardSignature(payload) {
  return JSON.stringify({
    name: payload.displayName || '',
    usernameRaw: payload.usernameRaw || ''
  });
}

async function refreshUserInfoCard(
  userId,
  from,
  env,
  force = false
) {
  const user = await dbUserGetOrCreate(
    userId,
    env
  );

  if (
    !user.topic_id ||
    !user.info_card_message_id
  ) {
    return {
      updated: false,
      reason: 'missing_card'
    };
  }

  const firstMessageDate =
    user.user_info?.first_message_date ||
    user.created_at ||
    null;

  const fingerprintHtml =
    await buildFingerprintHtml(
      env,
      user.user_id
    );

  const payload = buildUserInfoPayload(
    from,
    firstMessageDate,
    fingerprintHtml
  );

  const oldSignature = JSON.stringify({
    name: user.user_info?.name || '',
    usernameRaw:
      user.user_info?.username_raw || ''
  });

  const newSignature =
    buildCardSignature(payload);

  if (
    !force &&
    oldSignature === newSignature
  ) {
    return {
      updated: false,
      reason: 'not_modified'
    };
  }

    try {
    await telegramApi(
      env.BOT_TOKEN,
      'editMessageText',
      {
        chat_id: env.ADMIN_GROUP_ID,
        message_id: Number(
          user.info_card_message_id
        ),
        text: payload.infoCard,
        parse_mode: 'HTML',
        reply_markup: getInfoCardButtons(
          userId,
          user.is_blocked,
          user.is_muted,
          payload.usernameRaw
        )
      }
    );
  } catch (error) {
    if (isMessageNotModifiedError(error)) {
      return {
        updated: false,
        reason: 'not_modified'
      };
    }

    throw error;
  }


  await dbUserUpdate(
    userId,
    {
      user_info: {
        name: payload.displayName,
        username: payload.usernameDisplay,
        username_raw: payload.usernameRaw,
        first_message_date: firstMessageDate
      }
    },
    env
  );

  try {
    await telegramApi(
      env.BOT_TOKEN,
      'editForumTopic',
      {
        chat_id: env.ADMIN_GROUP_ID,
        message_thread_id: Number(
          user.topic_id
        ),
        name: payload.topicName
      }
    );
  } catch (error) {
    const message = String(
      error?.message || error
    );

    if (
      !message.includes(
        'TOPIC_NOT_MODIFIED'
      ) &&
      !message.includes(
        'topic is not modified'
      )
    ) {
      console.error(
        '更新话题名称失败：',
        message
      );
    }
  }

  return {
    updated: true,
    reason: 'updated'
  };
}

async function createInfoCard(
  message,
  user,
  topicId,
  env
) {
  const fingerprintHtml =
    await buildFingerprintHtml(
      env,
      user.user_id
    );

  const payload = buildUserInfoPayload(
    message.from,
    message.date,
    fingerprintHtml
  );

  const sent = await telegramApi(
    env.BOT_TOKEN,
    'sendMessage',
    {
      chat_id: env.ADMIN_GROUP_ID,
      message_thread_id: Number(topicId),
      text: payload.infoCard,
      parse_mode: 'HTML',
      reply_markup: getInfoCardButtons(
        payload.userId,
        user.is_blocked,
        user.is_muted,
        payload.usernameRaw
      )
    }
  );

  await dbUserUpdate(
    payload.userId,
    {
      info_card_message_id:
        String(sent.message_id),
      user_info: {
        name: payload.displayName,
        username: payload.usernameDisplay,
        username_raw: payload.usernameRaw,
        first_message_date: message.date
      }
    },
    env
  );

  return sent.message_id;
}
const infoCardPromises = new Map();

async function ensureUserInfoCard(
  message,
  user,
  topicId,
  env
) {
  const userId = String(message.from.id);
  const lockKey = `${userId}:${topicId}`;

  const freshUser = await dbUserGetOrCreate(
    userId,
    env
  );

  if (freshUser.info_card_message_id) {
    return freshUser.info_card_message_id;
  }

  if (infoCardPromises.has(lockKey)) {
    return infoCardPromises.get(lockKey);
  }

  const task = (async () => {
    let lastError = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const currentUser =
        await dbUserGetOrCreate(userId, env);

      if (currentUser.info_card_message_id) {
        return currentUser.info_card_message_id;
      }

      try {
        return await createInfoCard(
          message,
          currentUser,
          topicId,
          env
        );
      } catch (error) {
        lastError = error;

        console.error(
          `创建资料卡失败（${attempt}/3），用户 ${userId}：`,
          error?.message || error
        );

        if (attempt < 3) {
          await sleep(attempt * 500);
        }
      }
    }

    console.error(
      `用户 ${userId} 的资料卡创建失败：`,
      lastError?.message || lastError
    );

    return null;
  })();

  infoCardPromises.set(lockKey, task);

  try {
    return await task;
  } finally {
    if (infoCardPromises.get(lockKey) === task) {
      infoCardPromises.delete(lockKey);
    }
  }
}

async function recreateUserInfoCard(
  userId,
  topicId,
  env
) {
  const normalizedUserId = String(userId);
  const normalizedTopicId = String(topicId);

  let user = await dbUserGetOrCreate(
    normalizedUserId,
    env
  );

  const oldCardMessageId =
    user.info_card_message_id;

  const userInfo = user.user_info || {};

  const displayName =
    String(userInfo.name || '').trim() ||
    `用户 ${normalizedUserId}`;

  const usernameRaw =
    String(userInfo.username_raw || '').trim();

  const firstMessageDate = Number(
    userInfo.first_message_date ||
    user.created_at ||
    Math.floor(Date.now() / 1000)
  );

  await dbUserUpdate(
    normalizedUserId,
    {
      topic_id: normalizedTopicId,
      info_card_message_id: null,
      topic_creating: false,
      topic_lock_at: null
    },
    env
  );

  user = await dbUserGetOrCreate(
    normalizedUserId,
    env
  );

  const syntheticMessage = {
    from: {
      id: normalizedUserId,
      first_name: displayName,
      username: usernameRaw || undefined
    },
    date: firstMessageDate
  };

  let newCardMessageId;

  try {
    newCardMessageId = await createInfoCard(
      syntheticMessage,
      user,
      normalizedTopicId,
      env
    );
  } catch (error) {
    // 重建失败时恢复旧资料卡 ID，避免数据库状态进一步损坏。
    await dbUserUpdate(
      normalizedUserId,
      {
        info_card_message_id:
          oldCardMessageId || null
      },
      env
    );

    throw error;
  }

  // 新卡创建成功后再删除旧卡，避免先删除后创建失败。
  if (
    oldCardMessageId &&
    String(oldCardMessageId) !==
      String(newCardMessageId)
  ) {
    try {
      await telegramApi(
        env.BOT_TOKEN,
        'deleteMessage',
        {
          chat_id: env.ADMIN_GROUP_ID,
          message_id: Number(oldCardMessageId)
        }
      );
    } catch (error) {
      console.warn(
        `旧资料卡不存在或无法删除，用户 ${normalizedUserId}：`,
        error?.message || error
      );
    }
  }

  return newCardMessageId;
}

async function waitForUserTopic(userId, env) {
  for (let i = 0; i < 12; i += 1) {
    await sleep(250);

    const user = await dbUserGet(
      userId,
      env
    );

    if (user?.topic_id) {
      return user.topic_id;
    }

    if (!user?.topic_creating) {
      break;
    }
  }

  return null;
}

async function ensureUserTopic(
  message,
  existingUser,
  env
) {
  const userId = String(message.from.id);
  let user =
    existingUser ||
    await dbUserGetOrCreate(userId, env);

if (user.topic_id) {
  if (!user.info_card_message_id) {
    await ensureUserInfoCard(
      message,
      user,
      user.topic_id,
      env
    );
  }

  return user.topic_id;
}

  const now = Math.floor(Date.now() / 1000);
  const staleTime =
    now - TOPIC_LOCK_TIMEOUT_SECONDS;

  const lockResult =
    await env.TG_BOT_DB.prepare(`
      UPDATE users
      SET
        topic_creating = 1,
        topic_lock_at = ?,
        updated_at = ?
      WHERE user_id = ?
        AND topic_id IS NULL
        AND (
          topic_creating = 0
          OR topic_lock_at IS NULL
          OR topic_lock_at < ?
        )
    `).bind(
      now,
      now,
      userId,
      staleTime
    ).run();

  const acquired =
    Number(lockResult?.meta?.changes || 0) > 0;

  if (!acquired) {
    const topicId = await waitForUserTopic(
      userId,
      env
    );

    if (topicId) {
      return topicId;
    }

    user = await dbUserGetOrCreate(
      userId,
      env
    );

    if (user.topic_id) {
      return user.topic_id;
    }

    throw new Error(
      '用户话题正在创建，请稍后重试'
    );
  }

  try {
    const fingerprintHtml =
      await buildFingerprintHtml(
        env,
        userId
      );

    const payload = buildUserInfoPayload(
      message.from,
      message.date,
      fingerprintHtml
    );

    const topic = await telegramApi(
      env.BOT_TOKEN,
      'createForumTopic',
      {
        chat_id: env.ADMIN_GROUP_ID,
        name: payload.topicName
      }
    );

    const topicId = String(
      topic.message_thread_id
    );

    // 先保存话题 ID，避免资料卡发送失败时重复创建话题。
    await dbUserUpdate(
      userId,
      {
        topic_id: topicId,
        topic_creating: false,
        topic_lock_at: null
      },
      env
    );

    await ensureUserInfoCard(
      message,
      user,
      topicId,
      env
    );

    return topicId;
  } catch (error) {
    await dbUserUpdate(
      userId,
      {
        topic_creating: false,
        topic_lock_at: null
      },
      env
    );

    throw error;
  }
}

async function maybeAutoRefreshUserCard(
  message,
  env
) {
  if (!message?.from?.id) return;

  const userId = String(message.from.id);
  const user = await dbUserGetOrCreate(
    userId,
    env
  );

  if (
    !user.topic_id ||
    !user.info_card_message_id
  ) {
    return;
  }

  const oldName =
    user.user_info?.name || '';

  const oldUsernameRaw =
    user.user_info?.username_raw || '';

  const newName = (
    `${message.from.first_name || ''}` +
    `${message.from.last_name
      ? ` ${message.from.last_name}`
      : ''}`
  ).trim() || '未知用户';

  const newUsernameRaw =
    message.from.username || '';

  if (
    oldName === newName &&
    oldUsernameRaw === newUsernameRaw
  ) {
    return;
  }

  try {
    await refreshUserInfoCard(
      userId,
      message.from,
      env
    );
  } catch (error) {
    console.error(
      '自动刷新资料卡失败：',
      error?.message || error
    );
  }
}

/* -------------------------------------------------------------------------- */
/*                                消息转发                                       */
/* -------------------------------------------------------------------------- */

async function saveUserMessageRecord(
  message,
  env
) {
  if (!message.text && !message.caption) {
    return;
  }

  try {
    await dbMessageDataPut(
      String(message.from.id),
      getMessageStorageKey(
        'user',
        message.message_id
      ),
      {
        text:
          message.text ||
          message.caption ||
          '',
        date: message.date
      },
      env
    );
  } catch (error) {
    console.error(
      '保存用户消息记录失败：',
      error?.message || error
    );
  }
}

async function relayUserMessageToTopic(
  message,
  user,
  env
) {
  const userId = String(message.from.id);

  // 获取最新用户状态，防止并发请求使用过期数据。
  let freshUser = await dbUserGetOrCreate(
    userId,
    env
  );

  // 统一确保话题存在，同时补建缺失的资料卡。
  let topicId = await ensureUserTopic(
    message,
    freshUser,
    env
  );

  freshUser = await dbUserGetOrCreate(
    userId,
    env
  );

  if (!freshUser.info_card_message_id) {
    await ensureUserInfoCard(
      message,
      freshUser,
      topicId,
      env
    );
  } else {
    await maybeAutoRefreshUserCard(
      message,
      env
    );
  }

  try {
    await telegramApi(
      env.BOT_TOKEN,
      'copyMessage',
      {
        chat_id: env.ADMIN_GROUP_ID,
        message_thread_id:
          Number(topicId),
        from_chat_id:
          String(message.chat.id),
        message_id:
          message.message_id,
        disable_notification:
          Boolean(
            freshUser.is_blocked ||
            freshUser.is_muted
          )
      }
    );
  } catch (error) {
    if (!isTopicInvalidError(error)) {
      throw error;
    }

    console.error(
      '用户话题已失效，准备重建：',
      error?.message || error
    );

    await dbUserUpdate(
      userId,
      {
        topic_id: null,
        info_card_message_id: null,
        topic_creating: false,
        topic_lock_at: null
      },
      env
    );

    const refreshedUser =
      await dbUserGetOrCreate(
        userId,
        env
      );

    const newTopicId =
      await ensureUserTopic(
        message,
        refreshedUser,
        env
      );

    const newestUser =
      await dbUserGetOrCreate(
        userId,
        env
      );

    if (!newestUser.info_card_message_id) {
      await ensureUserInfoCard(
        message,
        newestUser,
        newTopicId,
        env
      );
    }

    await telegramApi(
      env.BOT_TOKEN,
      'copyMessage',
      {
        chat_id: env.ADMIN_GROUP_ID,
        message_thread_id:
          Number(newTopicId),
        from_chat_id:
          String(message.chat.id),
        message_id:
          message.message_id,
        disable_notification:
          Boolean(
            newestUser.is_blocked ||
            newestUser.is_muted
          )
      }
    );

    topicId = newTopicId;
  }

  await saveUserMessageRecord(
    message,
    env
  );
}
async function relayAdminMessageToUser(
  message,
  userId,
  env
) {
  return telegramApi(
    env.BOT_TOKEN,
    'copyMessage',
    {
      chat_id: String(userId),
      from_chat_id:
        String(message.chat.id),
      message_id: message.message_id
    }
  );
}

/* -------------------------------------------------------------------------- */
/*                               菜单渲染函数                                    */
/* -------------------------------------------------------------------------- */

async function renderMenu(
  env,
  {
    chatId,
    messageId = 0,
    text,
    reply_markup,
    parse_mode = 'HTML'
  }
) {
  const params = {
    chat_id: chatId,
    text,
    parse_mode,
    reply_markup
  };

  if (!messageId) {
    await telegramApi(
      env.BOT_TOKEN,
      'sendMessage',
      params
    );

    return;
  }

  try {
    await telegramApi(
      env.BOT_TOKEN,
      'editMessageText',
      {
        ...params,
        message_id: messageId
      }
    );
  } catch (error) {
    const errorText = String(
      error?.message || error
    ).toLowerCase();

    if (
      errorText.includes(
        'message is not modified'
      )
    ) {
      return;
    }

    if (
      errorText.includes(
        'message to edit not found'
      ) ||
      errorText.includes(
        "message can't be edited"
      )
    ) {
      await telegramApi(
        env.BOT_TOKEN,
        'sendMessage',
        params
      );

      return;
    }

    throw error;
  }
}

async function showMainMenu(
  chatId,
  env,
  messageId = 0
) {
  const text = `
⚙️ <b>机器人主配置菜单</b>

请选择要管理的配置类别：
  `.trim();

  const reply_markup = {
    inline_keyboard: [
      [
        {
          text: '📝 基础配置',
          callback_data:
            'config:menu:base'
        }
      ],
      [
        {
          text: '🤖 自动回复管理',
          callback_data:
            'config:menu:autoreply'
        }
      ],
      [
        {
          text: '🚫 关键词屏蔽管理',
          callback_data:
            'config:menu:keyword'
        }
      ],
      [
        {
          text: '🔗 按类型过滤管理',
          callback_data:
            'config:menu:filter'
        }
      ],
      [
        {
          text: '🧑‍💻 协管员授权设置',
          callback_data:
            'config:menu:authorized'
        }
      ],
      [
        {
          text: '🔄 刷新主菜单',
          callback_data: 'config:menu'
        }
      ]
    ]
  };

  await renderMenu(env, {
    chatId,
    messageId,
    text,
    reply_markup
  });
}

async function showBaseMenu(
  chatId,
  env,
  messageId = 0
) {
  const welcomeMsg = await getConfig(
    'welcome_msg',
    env
  );

  const verificationQuestion =
    await getConfig('verif_q', env);

  const verificationAnswer =
    await getConfig('verif_a', env);

  const text = `
⚙️ <b>基础配置</b>

<b>当前设置：</b>
• 欢迎消息：${escapeHtml(welcomeMsg).slice(0, 30)}${welcomeMsg.length > 30 ? '…' : ''}
• 验证问题：${escapeHtml(verificationQuestion).slice(0, 30)}${verificationQuestion.length > 30 ? '…' : ''}
• 验证答案：<code>${escapeHtml(verificationAnswer)}</code>

请选择要修改的配置项：
  `.trim();

  const reply_markup = {
    inline_keyboard: [
      [
        {
          text: '📝 编辑欢迎消息',
          callback_data:
            'config:edit:welcome_msg'
        }
      ],
      [
        {
          text: '❓ 编辑验证问题',
          callback_data:
            'config:edit:verif_q'
        }
      ],
      [
        {
          text: '🔑 编辑验证答案',
          callback_data:
            'config:edit:verif_a'
        }
      ],
      [
        {
          text: '⬅️ 返回主菜单',
          callback_data: 'config:menu'
        }
      ]
    ]
  };

  await renderMenu(env, {
    chatId,
    messageId,
    text,
    reply_markup
  });
}

async function showAutoReplyMenu(
  chatId,
  env,
  messageId = 0
) {
  const rules = await getAutoReplyRules(env);

  const text = `
🤖 <b>自动回复管理</b>

当前规则数量：${rules.length}

新增规则格式：
<code>关键词表达式===回复内容</code>
  `.trim();

  const reply_markup = {
    inline_keyboard: [
      [
        {
          text: '➕ 新增规则',
          callback_data:
            'config:add:keyword_responses'
        }
      ],
      [
        {
          text: '📋 查看规则列表',
          callback_data:
            'config:list:keyword_responses:0'
        }
      ],
      [
        {
          text: '⬅️ 返回主菜单',
          callback_data: 'config:menu'
        }
      ]
    ]
  };

  await renderMenu(env, {
    chatId,
    messageId,
    text,
    reply_markup
  });
}

async function showKeywordMenu(
  chatId,
  env,
  messageId = 0
) {
  const keywords =
    await getBlockKeywords(env);

  const threshold =
    await getBlockThreshold(env);

  const preview = keywords
    .slice(0, 5)
    .map(
      (keyword) =>
        `• ${escapeHtml(keyword)}`
    )
    .join('\n') || '无';

  const text = `
🚫 <b>关键词屏蔽管理</b>

当前阈值：<code>${threshold}</code>
当前规则数量：${keywords.length}

前 5 条预览：
${preview}
  `.trim();

  const reply_markup = {
    inline_keyboard: [
      [
        {
          text: '➕ 新增屏蔽关键词',
          callback_data:
            'config:add:block_keywords'
        }
      ],
      [
        {
          text: '📝 修改屏蔽阈值',
          callback_data:
            'config:edit:block_threshold'
        }
      ],
      [
        {
          text: '📋 查看关键词列表',
          callback_data:
            'config:list:block_keywords:0'
        }
      ],
      [
        {
          text: '⬅️ 返回主菜单',
          callback_data: 'config:menu'
        }
      ]
    ]
  };

  await renderMenu(env, {
    chatId,
    messageId,
    text,
    reply_markup
  });
}

function filterStatus(value) {
  return value ? '✅ 开' : '❌ 关';
}

async function showFilterMenu(
  chatId,
  env,
  messageId = 0
) {
  const filters =
    await getFilterConfig(env);

  const text = `
🔗 <b>按类型过滤管理</b>

点击按钮即可切换状态：
  `.trim();

  const reply_markup = {
    inline_keyboard: [
      [
        {
          text:
            `1. 图片/视频/文件 ` +
            filterStatus(filters.media),
          callback_data:
            'config:toggle:' +
            'enable_image_forwarding:' +
            `${!filters.media}`
        }
      ],
      [
        {
          text:
            `2. 链接 ` +
            filterStatus(filters.link),
          callback_data:
            'config:toggle:' +
            'enable_link_forwarding:' +
            `${!filters.link}`
        },
        {
          text:
            `3. 文本 ` +
            filterStatus(filters.text),
          callback_data:
            'config:toggle:' +
            'enable_text_forwarding:' +
            `${!filters.text}`
        }
      ],
      [
        {
          text:
            `4. 音频/语音 ` +
            filterStatus(
              filters.audio_voice
            ),
          callback_data:
            'config:toggle:' +
            'enable_audio_forwarding:' +
            `${!filters.audio_voice}`
        }
      ],
      [
        {
          text:
            `5. 贴纸/GIF ` +
            filterStatus(
              filters.sticker_gif
            ),
          callback_data:
            'config:toggle:' +
            'enable_sticker_forwarding:' +
            `${!filters.sticker_gif}`
        }
      ],
      [
        {
          text:
            `6. 用户转发 ` +
            filterStatus(
              filters.user_forward
            ),
          callback_data:
            'config:toggle:' +
            'enable_user_forwarding:' +
            `${!filters.user_forward}`
        }
      ],
      [
        {
          text:
            `7. 群组转发 ` +
            filterStatus(
              filters.group_forward
            ),
          callback_data:
            'config:toggle:' +
            'enable_group_forwarding:' +
            `${!filters.group_forward}`
        }
      ],
      [
        {
          text:
            `8. 频道转发 ` +
            filterStatus(
              filters.channel_forward
            ),
          callback_data:
            'config:toggle:' +
            'enable_channel_forwarding:' +
            `${!filters.channel_forward}`
        }
      ],
      [
        {
          text: '⬅️ 返回主菜单',
          callback_data: 'config:menu'
        }
      ]
    ]
  };

  await renderMenu(env, {
    chatId,
    messageId,
    text,
    reply_markup
  });
}

async function showAuthorizedMenu(
  chatId,
  env,
  messageId = 0
) {
  const primaryAdmins =
    getPrimaryAdminIds(env);

  const authorized =
    await getAuthorizedAdmins(env);

  const all = [
    ...new Set([
      ...primaryAdmins,
      ...authorized
    ])
  ];

  const text = `
🧑‍💻 <b>协管员授权设置</b>

<b>主管理员：</b>
<code>${escapeHtml(primaryAdmins.join(', ') || '无')}</code>

<b>已授权协管员：</b>
<code>${escapeHtml(authorized.join(', ') || '无')}</code>

<b>总人数：</b>${all.length}

输入格式：多个 ID 使用英文逗号分隔。
  `.trim();

  const reply_markup = {
    inline_keyboard: [
      [
        {
          text: '✏️ 设置/修改协管员列表',
          callback_data:
            'config:edit:authorized_admins'
        }
      ],
      [
        {
          text:
            `🗑️ 清空协管员列表 ` +
            `(${authorized.length}人)`,
          callback_data:
            'config:clear:authorized_admins'
        }
      ],
      [
        {
          text: '⬅️ 返回主菜单',
          callback_data: 'config:menu'
        }
      ]
    ]
  };

  await renderMenu(env, {
    chatId,
    messageId,
    text,
    reply_markup
  });
}

/* -------------------------------------------------------------------------- */
/*                               验证处理                                       */
/* -------------------------------------------------------------------------- */

async function handleStart(
  chatId,
  env
) {
  const welcomeMessage = await getConfig(
    'welcome_msg',
    env
  );

  const sessionId = genSessionId();
  const ttlMinutes = 30;

  await dbCreateVerifySession(
    env,
    sessionId,
    chatId,
    ttlMinutes
  );

  const verifyUrl =
    `${env.APP_BASE_URL}/verify/${sessionId}`;

  await telegramApi(
    env.BOT_TOKEN,
    'sendMessage',
    {
      chat_id: chatId,
      text: welcomeMessage,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '🤖 点击进行人机验证',
              web_app: { url: verifyUrl }
            }
          ]
        ]
      }
    }
  );

  await dbUserUpdate(
    chatId,
    {
      user_state: USER_STATE.PENDING
    },
    env
  );
}

/* -------------------------------------------------------------------------- */
/*                             管理员配置输入处理                                 */
/* -------------------------------------------------------------------------- */

async function sendAdminInputError(
  userId,
  text,
  env
) {
  await telegramApi(
    env.BOT_TOKEN,
    'sendMessage',
    {
      chat_id: userId,
      text
    }
  );
}

async function handleAdminConfigInput(
  userId,
  text,
  state,
  env
) {
  if (
    !state ||
    state.action !== 'awaiting_input'
  ) {
    await clearAdminState(userId, env);
    return;
  }

  if (
    String(text || '').toLowerCase() ===
    '/cancel'
  ) {
    await clearAdminState(userId, env);

    await telegramApi(
      env.BOT_TOKEN,
      'sendMessage',
      {
        chat_id: userId,
        text: '❌ 已取消输入。'
      }
    );

    await showMainMenu(userId, env);
    return;
  }

  let finalValue = String(text || '');

  if (!finalValue.trim()) {
    await sendAdminInputError(
      userId,
      '⚠️ 输入内容不能为空，或发送 /cancel 取消。',
      env
    );

    return;
  }

  if (state.key === 'welcome_msg') {
    if (
      finalValue.length >
      LIMITS.welcome_msg
    ) {
      await sendAdminInputError(
        userId,
        `⚠️ 欢迎消息最多允许 ` +
        `${LIMITS.welcome_msg} 个字符。`,
        env
      );

      return;
    }
  }

  if (state.key === 'verif_q') {
    if (
      finalValue.length > LIMITS.verif_q
    ) {
      await sendAdminInputError(
        userId,
        `⚠️ 验证问题最多允许 ` +
        `${LIMITS.verif_q} 个字符。`,
        env
      );

      return;
    }
  }

  if (state.key === 'verif_a') {
    finalValue = finalValue.trim();

    if (
      finalValue.length > LIMITS.verif_a
    ) {
      await sendAdminInputError(
        userId,
        `⚠️ 验证答案最多允许 ` +
        `${LIMITS.verif_a} 个字符。`,
        env
      );

      return;
    }
  }

  if (state.key === 'block_threshold') {
    const threshold = Number(
      finalValue.trim()
    );

    if (
      !Number.isInteger(threshold) ||
      threshold < 1 ||
      threshold > 100
    ) {
      await sendAdminInputError(
        userId,
        '⚠️ 屏蔽阈值必须是 1 到 100 之间的整数。',
        env
      );

      return;
    }

    finalValue = String(threshold);
  }

  if (state.key === 'authorized_admins') {
    if (
      finalValue.length >
      LIMITS.authorized_admins
    ) {
      await sendAdminInputError(
        userId,
        '⚠️ 协管员列表内容过长。',
        env
      );

      return;
    }

    const ids = [
      ...new Set(
        finalValue
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
      )
    ];

    const invalidIds = ids.filter(
      (id) => !/^\d+$/.test(id)
    );

    if (invalidIds.length > 0) {
      await sendAdminInputError(
        userId,
        `⚠️ 以下 ID 格式不正确：` +
        `${invalidIds.slice(0, 5).join(', ')}`,
        env
      );

      return;
    }

    finalValue = JSON.stringify(ids);
  }

  if (state.key === 'block_keywords_add') {
    const newKeyword =
      finalValue.trim();

    if (
      newKeyword.length >
      LIMITS.block_keyword
    ) {
      await sendAdminInputError(
        userId,
        `⚠️ 关键词表达式最多允许 ` +
        `${LIMITS.block_keyword} 个字符。`,
        env
      );

      return;
    }

    try {
      validateRegexPattern(newKeyword);
    } catch (error) {
      await sendAdminInputError(
        userId,
        `⚠️ 无效的表达式：` +
        `${error?.message || error}`,
        env
      );

      return;
    }

    const keywords =
      await getBlockKeywords(env);

    if (keywords.includes(newKeyword)) {
      await sendAdminInputError(
        userId,
        '⚠️ 该关键词已经存在。',
        env
      );

      return;
    }

    keywords.push(newKeyword);

    await setConfig(
      'block_keywords',
      JSON.stringify(keywords),
      env
    );

    await clearAdminState(userId, env);

    await telegramApi(
      env.BOT_TOKEN,
      'sendMessage',
      {
        chat_id: userId,
        text: '✅ 屏蔽关键词已添加。'
      }
    );

    await showKeywordMenu(userId, env);
    return;
  }

  if (
    state.key === 'keyword_responses_add'
  ) {
    const separatorIndex =
      finalValue.indexOf('===');

    const keywordExpression =
      separatorIndex >= 0
        ? finalValue
            .slice(0, separatorIndex)
            .trim()
        : '';

    const responseText =
      separatorIndex >= 0
        ? finalValue
            .slice(separatorIndex + 3)
            .trim()
        : '';

    if (
      !keywordExpression ||
      !responseText
    ) {
      await sendAdminInputError(
        userId,
        '⚠️ 格式错误，请使用：' +
        '关键词表达式===回复内容',
        env
      );

      return;
    }

    if (
      keywordExpression.length >
      LIMITS.auto_reply_pattern
    ) {
      await sendAdminInputError(
        userId,
        `⚠️ 关键词表达式最多允许 ` +
        `${LIMITS.auto_reply_pattern} 个字符。`,
        env
      );

      return;
    }

    if (
      responseText.length >
      LIMITS.auto_reply_response
    ) {
      await sendAdminInputError(
        userId,
        `⚠️ 回复内容最多允许 ` +
        `${LIMITS.auto_reply_response} 个字符。`,
        env
      );

      return;
    }

    try {
      validateRegexPattern(
        keywordExpression
      );
    } catch (error) {
      await sendAdminInputError(
        userId,
        `⚠️ 无效的表达式：` +
        `${error?.message || error}`,
        env
      );

      return;
    }

    const rules =
      await getAutoReplyRules(env);

    rules.push({
      id: randomId(),
      keywords: keywordExpression,
      response: responseText
    });

    await setConfig(
      'keyword_responses',
      JSON.stringify(rules),
      env
    );

    await clearAdminState(userId, env);

    await telegramApi(
      env.BOT_TOKEN,
      'sendMessage',
      {
        chat_id: userId,
        text: '✅ 自动回复规则已添加。'
      }
    );

    await showAutoReplyMenu(userId, env);
    return;
  }

  await setConfig(
    state.key,
    finalValue,
    env
  );

  await clearAdminState(userId, env);

  await telegramApi(
    env.BOT_TOKEN,
    'sendMessage',
    {
      chat_id: userId,
      text:
        `✅ 配置项 ${state.key} 已更新。`
    }
  );

  if (
    [
      'welcome_msg',
      'verif_q',
      'verif_a'
    ].includes(state.key)
  ) {
    await showBaseMenu(userId, env);
  } else if (
    state.key === 'block_threshold'
  ) {
    await showKeywordMenu(userId, env);
  } else if (
    state.key === 'authorized_admins'
  ) {
    await showAuthorizedMenu(
      userId,
      env
    );
  } else {
    await showMainMenu(userId, env);
  }
}

/* -------------------------------------------------------------------------- */
/*                               私聊消息处理                                    */
/* -------------------------------------------------------------------------- */

async function handleBlockedKeyword(
  userId,
  chatId,
  hitKeyword,
  env
) {
  const threshold =
    await getBlockThreshold(env);

  const result = await incrementBlockCount(
    userId,
    threshold,
    env
  );

  await telegramApi(
    env.BOT_TOKEN,
    'sendMessage',
    {
      chat_id: chatId,
      text:
        `⚠️ 您的消息触发了关键词过滤器 ` +
        `(${result.currentCount}/${threshold} 次)，` +
        `消息已丢弃。`
    }
  );

  if (result.shouldAutoBlock) {
    // 自动封禁同步写入黑名单
    try {
      await dbBlacklistAdd(
        env,
        userId,
        '关键词触发自动封禁',
        'auto'
      );
    } catch (e) {
      console.error(
        '写入黑名单失败：',
        e?.message || e
      );
    }

    await telegramApi(
      env.BOT_TOKEN,
      'sendMessage',
      {
        chat_id: chatId,
        text:
          '❌ 您已多次触发关键词过滤，' +
          '当前已被自动屏蔽。'
      }
    );
  }

  console.log(
    `用户 ${userId} 命中关键词：`,
    hitKeyword
  );
}

async function handlePrivateMessage(
  message,
  env
) {
  if (!message?.chat?.id) return;

  const chatId =
    String(message.chat.id);

  const userId =
    String(message.from?.id || chatId);

  const text = getMessageText(message);
  const commandText =
    String(message.text || '').trim();

  const isPrimary =
    isPrimaryAdmin(userId, env);

  const isAdmin =
    await isAdminUser(userId, env);

  // 检查是否处于测试验证模式（管理员可通过 /testverify 进入）
  const isTestMode =
    (await getConfig(
      `test_verify_${userId}`,
      env
    )) === '1';

  if (
    commandText === '/testverify'
  ) {
    // 仅主管理员可使用此命令，用于测试验证流程
    if (!isPrimary) {
      await telegramApi(
        env.BOT_TOKEN,
        'sendMessage',
        {
          chat_id: chatId,
          text: '⚠️ 此命令仅限主管理员使用。'
        }
      );
      return;
    }

    // 设置测试模式标记
    await setConfig(
      `test_verify_${userId}`,
      '1',
      env
    );

    // 重置用户状态为 NEW
    await dbUserUpdate(
      userId,
      { user_state: USER_STATE.NEW },
      env
    );

    await telegramApi(
      env.BOT_TOKEN,
      'sendMessage',
      {
        chat_id: chatId,
        text:
          '🔧 已进入验证测试模式，' +
          '您的验证状态已重置。' +
          '接下来将显示验证流程，' +
          '验证完成后自动退出测试模式。'
      }
    );

    // 显示验证流程
    await handleStart(chatId, env);
    return;
  }

  // /fp 命令：查看指纹信息（仅管理员可用）
  if (
    commandText === '/fp' ||
    commandText.startsWith('/fp ')
  ) {
    if (!isAdmin) {
      await telegramApi(
        env.BOT_TOKEN,
        'sendMessage',
        {
          chat_id: chatId,
          text: '⚠️ 此命令仅限管理员使用。'
        }
      );
      return;
    }

    // 支持查看指定用户：/fp <user_id>
    const targetUserId =
      commandText
        .split(/\s+/)[1]
        ?.trim() || userId;

    const fpHtml =
      await buildFingerprintHtml(
        env,
        String(targetUserId)
      );

    if (!fpHtml) {
      await telegramApi(
        env.BOT_TOKEN,
        'sendMessage',
        {
          chat_id: chatId,
          text:
            `📭 用户 <code>${escapeHtml(
              String(targetUserId)
            )}</code> 暂无指纹记录。`
        }
      );
      return;
    }

    await telegramApi(
      env.BOT_TOKEN,
      'sendMessage',
      {
        chat_id: chatId,
        text:
          `📋 用户 <code>${escapeHtml(
            String(targetUserId)
          )}</code> 的指纹信息：\n` +
          fpHtml,
        parse_mode: 'HTML'
      }
    );
    return;
  }

  // /fplist 命令：列出所有指纹记录（仅管理员可用）
  if (commandText === '/fplist') {
    if (!isAdmin) {
      await telegramApi(
        env.BOT_TOKEN,
        'sendMessage',
        {
          chat_id: chatId,
          text: '⚠️ 此命令仅限管理员使用。'
        }
      );
      return;
    }

    const list = await listFingerprints(env, 20);
    if (!list.length) {
      await telegramApi(
        env.BOT_TOKEN,
        'sendMessage',
        {
          chat_id: chatId,
          text: '📭 暂无任何指纹记录。'
        }
      );
      return;
    }

    let text =
      `📋 <b>最近 ${list.length} 条指纹记录</b>\n\n`;
    for (const h of list) {
      let dev = {};
      try {
        dev = JSON.parse(
          h.fingerprint.device_json || '{}'
        );
      } catch {}

      const tags = h.tags
        .map((t) => t.tag)
        .join(', ');

      text +=
        `━━━━━━━━━━━━━\n` +
        `<b>指纹 ID:</b> <code>${h.fingerprint.id}</code>\n` +
        `<b>用户 ID:</b> <code>${escapeHtml(
          String(h.fingerprint.user_id)
        )}</code>\n` +
        `<b>昵称:</b> ${escapeHtml(h.userInfo?.name || '未知')}\n` +
        `<b>用户名:</b> ${escapeHtml(h.userInfo?.username || '无')}\n` +
        `<b>系统:</b> ${escapeHtml(dev.os || 'N/A')}\n` +
        `<b>公网 IP:</b> <code>${escapeHtml(
          h.fingerprint.pub_ip || 'N/A'
        )}</code>\n` +
        `<b>WebRTC IP:</b> <code>${escapeHtml(
          h.fingerprint.webrtc_ip || 'N/A'
        )}</code>\n` +
        `<b>采集时间:</b> <code>${escapeHtml(
          formatTimestamp(
            h.fingerprint.created_at
          )
        )}</code>\n` +
        (tags
          ? `<b>标签:</b> ${escapeHtml(tags)}\n`
          : '');
    }

    await telegramApi(
      env.BOT_TOKEN,
      'sendMessage',
      {
        chat_id: chatId,
        text,
        parse_mode: 'HTML'
      }
    );
    return;
  }

  // /reset <用户ID> 命令：重置用户验证状态（仅主管理员可用）
  if (commandText.startsWith('/reset')) {
    if (!isPrimary) {
      await telegramApi(
        env.BOT_TOKEN,
        'sendMessage',
        {
          chat_id: chatId,
          text: '⚠️ 此命令仅限主管理员使用。'
        }
      );
      return;
    }

    const targetUserId =
      commandText
        .split(/\s+/)[1]
        ?.trim();

    if (!targetUserId) {
      await telegramApi(
        env.BOT_TOKEN,
        'sendMessage',
        {
          chat_id: chatId,
          text:
            '⚠️ 用法：/reset <用户ID>\n' +
            '例如：/reset 8215842959\n\n' +
            '重置后该用户需要重新验证。'
        }
      );
      return;
    }

    const targetUser =
      await dbUserGet(
        String(targetUserId),
        env
      );

    if (!targetUser) {
      await telegramApi(
        env.BOT_TOKEN,
        'sendMessage',
        {
          chat_id: chatId,
          text: `❌ 用户 ${escapeHtml(targetUserId)} 不存在。`
        }
      );
      return;
    }

    await dbUserUpdate(
      String(targetUserId),
      {
        user_state: USER_STATE.NEW,
        is_blocked: false
      },
      env
    );

    await telegramApi(
      env.BOT_TOKEN,
      'sendMessage',
      {
        chat_id: chatId,
        text:
          `✅ 已重置用户 <code>${escapeHtml(targetUserId)}</code> 的验证状态。\n` +
          `该用户下次发消息时将重新触发验证流程。\n\n` +
          `查看指纹：/fp ${escapeHtml(targetUserId)}`,
        parse_mode: 'HTML'
      }
    );
    return;
  }

  // /admin 命令：指纹标签管理 + 黑名单查看（仅管理员可用）
  if (
    commandText === '/admin' ||
    commandText.startsWith('/admin@') ||
    commandText.startsWith('/admin ')
  ) {
    if (!isAdmin) {
      await telegramApi(
        env.BOT_TOKEN,
        'sendMessage',
        {
          chat_id: chatId,
          text: '⚠️ 此命令仅限管理员使用。'
        }
      );
      return;
    }

    const parts = commandText.split(/\s+/);
    const sub = (parts[1] || '').toLowerCase();

    // /admin tag <指纹ID> <标签内容>
    if (sub === 'tag') {
      const fpId = Number(parts[2]);
      const tagText = parts.slice(3).join(' ').trim();

      if (
        !Number.isInteger(fpId) ||
        fpId <= 0 ||
        !tagText
      ) {
        await telegramApi(
          env.BOT_TOKEN,
          'sendMessage',
          {
            chat_id: chatId,
            text:
              '⚠️ 用法：/admin tag <指纹ID> <标签>\n' +
              '例如：/admin tag 12 block\n' +
              '可用 /fplist 查看指纹 ID。'
          }
        );
        return;
      }

      const fp = await dbGetFingerprintById(env, fpId);
      if (!fp) {
        await telegramApi(
          env.BOT_TOKEN,
          'sendMessage',
          {
            chat_id: chatId,
            text: `❌ 指纹 ID ${fpId} 不存在。`
          }
        );
        return;
      }

      await dbAddFingerprintTag(
        env,
        fpId,
        tagText.slice(0, 50),
        null
      );

      await telegramApi(
        env.BOT_TOKEN,
        'sendMessage',
        {
          chat_id: chatId,
          text:
            `✅ 已为指纹 ${fpId} 添加标签：` +
            `${escapeHtml(tagText)}\n` +
            `关联用户：<code>${escapeHtml(
              String(fp.user_id)
            )}</code>`,
          parse_mode: 'HTML'
        }
      );
      return;
    }

    // /admin untag <标签ID>
    if (sub === 'untag') {
      const tagId = Number(parts[2]);

      if (!Number.isInteger(tagId) || tagId <= 0) {
        await telegramApi(
          env.BOT_TOKEN,
          'sendMessage',
          {
            chat_id: chatId,
            text:
              '⚠️ 用法：/admin untag <标签ID>\n' +
              '可用 /admin tags <指纹ID> 查看标签 ID。'
          }
        );
        return;
      }

      await dbDeleteFingerprintTag(env, tagId);

      await telegramApi(
        env.BOT_TOKEN,
        'sendMessage',
        {
          chat_id: chatId,
          text: `✅ 已删除标签 ID ${tagId}。`
        }
      );
      return;
    }

    // /admin tags <指纹ID>
    if (sub === 'tags') {
      const fpId = Number(parts[2]);

      if (!Number.isInteger(fpId) || fpId <= 0) {
        await telegramApi(
          env.BOT_TOKEN,
          'sendMessage',
          {
            chat_id: chatId,
            text: '⚠️ 用法：/admin tags <指纹ID>'
          }
        );
        return;
      }

      const tags = await dbGetFingerprintTags(env, fpId);

      if (!tags.length) {
        await telegramApi(
          env.BOT_TOKEN,
          'sendMessage',
          {
            chat_id: chatId,
            text: `📭 指纹 ${fpId} 暂无标签。`
          }
        );
        return;
      }

      let text =
        `📋 <b>指纹 ${fpId} 的标签</b>\n\n`;
      for (const t of tags) {
        text +=
          `• <code>${t.id}</code> ` +
          `${escapeHtml(t.tag)}` +
          `（${escapeHtml(
            formatTimestamp(t.created_at)
          )}）\n`;
      }
      text +=
        '\n删除：/admin untag <标签ID>';

      await telegramApi(
        env.BOT_TOKEN,
        'sendMessage',
        {
          chat_id: chatId,
          text,
          parse_mode: 'HTML'
        }
      );
      return;
    }

    // /admin blacklist
    if (sub === 'blacklist') {
      const list = await dbBlacklistList(env);

      if (!list.length) {
        await telegramApi(
          env.BOT_TOKEN,
          'sendMessage',
          {
            chat_id: chatId,
            text: '📭 黑名单为空。'
          }
        );
        return;
      }

      let text =
        `📋 <b>黑名单（共 ${list.length}）</b>\n\n`;
      for (const b of list) {
        text +=
          `• <code>${escapeHtml(
            String(b.user_id)
          )}</code> ` +
          `${escapeHtml(b.reason || '')} ` +
          `[${escapeHtml(b.source || '')}] ` +
          `${escapeHtml(
            formatTimestamp(b.created_at)
          )}\n`;
      }

      await telegramApi(
        env.BOT_TOKEN,
        'sendMessage',
        {
          chat_id: chatId,
          text,
          parse_mode: 'HTML'
        }
      );
      return;
    }

    // /admin banip <IP> [原因] - 添加封禁 IP
    if (sub === 'banip') {
      const ip = (parts[2] || '').trim();
      const reason =
        parts.slice(3).join(' ').trim() ||
        '管理员手动封禁';

      if (!ip) {
        await telegramApi(
          env.BOT_TOKEN,
          'sendMessage',
          {
            chat_id: chatId,
            text:
              '⚠️ 用法：/admin banip <IP> [原因]\n' +
              '例如：/admin banip 1.2.3.4 VPN恶意用户\n\n' +
              '封禁后，公网 IP 或 WebRTC IP 命中该 IP 的用户，' +
              '验证完成时将被直接封禁。'
          }
        );
        return;
      }

      await dbBannedIpAdd(env, ip, reason);

      await telegramApi(
        env.BOT_TOKEN,
        'sendMessage',
        {
          chat_id: chatId,
          text:
            `✅ 已封禁 IP <code>${escapeHtml(
              ip
            )}</code>\n` +
            `原因：${escapeHtml(reason)}\n\n` +
            `该 IP 的用户验证完成时将被自动封禁。`,
          parse_mode: 'HTML'
        }
      );
      return;
    }

    // /admin unbanip <IP> - 解除 IP 封禁
    if (sub === 'unbanip') {
      const ip = (parts[2] || '').trim();

      if (!ip) {
        await telegramApi(
          env.BOT_TOKEN,
          'sendMessage',
          {
            chat_id: chatId,
            text: '⚠️ 用法：/admin unbanip <IP>'
          }
        );
        return;
      }

      await dbBannedIpRemove(env, ip);

      await telegramApi(
        env.BOT_TOKEN,
        'sendMessage',
        {
          chat_id: chatId,
          text: `✅ 已解除 IP <code>${escapeHtml(
            ip
          )}</code> 的封禁。`,
          parse_mode: 'HTML'
        }
      );
      return;
    }

    // /admin baniplist - 查看封禁 IP 列表
    if (sub === 'baniplist') {
      const list = await dbBannedIpList(env);

      if (!list.length) {
        await telegramApi(
          env.BOT_TOKEN,
          'sendMessage',
          {
            chat_id: chatId,
            text: '📭 封禁 IP 列表为空。'
          }
        );
        return;
      }

      let text =
        `📋 <b>封禁 IP（共 ${list.length}）</b>\n\n`;
      for (const b of list) {
        text +=
          `• <code>${escapeHtml(
            b.ip
          )}</code> ` +
          `${escapeHtml(b.reason || '')} ` +
          `${escapeHtml(
            formatTimestamp(b.created_at)
          )}\n`;
      }

      text +=
        '\n解除：/admin unbanip <IP>';

      await telegramApi(
        env.BOT_TOKEN,
        'sendMessage',
        {
          chat_id: chatId,
          text,
          parse_mode: 'HTML'
        }
      );
      return;
    }

    // 无子命令：显示用法
    await telegramApi(
      env.BOT_TOKEN,
      'sendMessage',
      {
        chat_id: chatId,
        text:
          '🛠 <b>/admin 管理命令</b>\n\n' +
          '• <code>/admin tag &lt;指纹ID&gt; &lt;标签&gt;</code> ' +
          '为指纹添加标签\n' +
          '• <code>/admin untag &lt;标签ID&gt;</code> ' +
          '删除指纹标签\n' +
          '• <code>/admin tags &lt;指纹ID&gt;</code> ' +
          '查看指纹标签\n' +
          '• <code>/admin blacklist</code> ' +
          '查看黑名单\n' +
          '• <code>/admin banip &lt;IP&gt; [原因]</code> ' +
          '封禁 IP（验证时命中直接封禁）\n' +
          '• <code>/admin unbanip &lt;IP&gt;</code> ' +
          '解除 IP 封禁\n' +
          '• <code>/admin baniplist</code> ' +
          '查看封禁 IP 列表\n\n' +
          '提示：用 <code>/fplist</code> 获取指纹 ID。\n' +
          '标签含 block/ban/黑名单/封禁 时，' +
          '验证阶段会自动拦截相似指纹。',
        parse_mode: 'HTML'
      }
    );
    return;
  }

  if (
    commandText === '/start' ||
    commandText === '/help'
  ) {
    // 测试模式下主管理员也走验证流程
    if (isPrimary && !isTestMode) {
      await showMainMenu(chatId, env);
      return;
    }

    const user =
      await dbUserGetOrCreate(
        userId,
        env
      );

    // 测试模式下协管员也走验证流程
    if (isAdmin && !isTestMode) {
      if (
        user.user_state !==
        USER_STATE.VERIFIED
      ) {
        await dbUserUpdate(
          userId,
          {
            user_state:
              USER_STATE.VERIFIED
          },
          env
        );
      }

      await telegramApi(
        env.BOT_TOKEN,
        'sendMessage',
        {
          chat_id: chatId,
          text:
            '✅ 您是已授权协管员，可以在管理群用户话题中回复消息。'
        }
      );

      return;
    }

    if (
      user.user_state ===
      USER_STATE.VERIFIED
    ) {
      await telegramApi(
        env.BOT_TOKEN,
        'sendMessage',
        {
          chat_id: chatId,
          text:
            '您已通过验证，可以直接发送消息。'
        }
      );
    } else {
      await handleStart(chatId, env);
    }

    return;
  }

  const user =
    await dbUserGetOrCreate(
      userId,
      env
    );

  if (user.is_blocked) {
    return;
  }

  if (isPrimary) {
    const adminState =
      await getAdminState(userId, env);

    if (adminState) {
      if (!message.text) {
        await telegramApi(
          env.BOT_TOKEN,
          'sendMessage',
          {
            chat_id: chatId,
            text:
              '⚠️ 当前正在等待文本配置，' +
              '请发送文字或使用 /cancel 取消。'
          }
        );

        return;
      }

      await handleAdminConfigInput(
        userId,
        message.text,
        adminState,
        env
      );

      return;
    }
  }

  // 测试模式下不自动验证管理员
  if (
    isAdmin &&
    !isTestMode &&
    user.user_state !==
      USER_STATE.VERIFIED
  ) {
    await dbUserUpdate(
      userId,
      {
        user_state: USER_STATE.VERIFIED
      },
      env
    );

    user.user_state =
      USER_STATE.VERIFIED;
  }

  if (
    user.user_state === USER_STATE.NEW
  ) {
    await handleStart(chatId, env);
    return;
  }

  if (
    user.user_state ===
    USER_STATE.PENDING
  ) {
    await handleStart(chatId, env);

    return;
  }

  if (
    user.user_state !==
    USER_STATE.VERIFIED
  ) {
    await telegramApi(
      env.BOT_TOKEN,
      'sendMessage',
      {
        chat_id: chatId,
        text:
          '请使用 /start 命令开始验证。'
      }
    );

    return;
  }

  const hitKeyword =
    await findBlockKeyword(text, env);

  if (hitKeyword) {
    await handleBlockedKeyword(
      userId,
      chatId,
      hitKeyword,
      env
    );

    return;
  }

  const filterResult =
    await checkForwardFilters(
      message,
      env
    );

  if (!filterResult.ok) {
    await telegramApi(
      env.BOT_TOKEN,
      'sendMessage',
      {
        chat_id: chatId,
        text:
          `⚠️ ${filterResult.reason}`
      }
    );

    return;
  }

  const autoReply =
    await matchAutoReply(text, env);

  if (autoReply) {
    // 修复：命中自动回复后不再转发给管理员，避免无意义打扰。
    // 如需"既自动回复又通知管理员"，删除此 return 即可。
    await telegramApi(
      env.BOT_TOKEN,
      'sendMessage',
      {
        chat_id: chatId,
        text: autoReply
      }
    );

    return;
  }

  await relayUserMessageToTopic(
    message,
    user,
    env
  );
}

/* -------------------------------------------------------------------------- */
/*                              管理员回复处理                                   */
/* -------------------------------------------------------------------------- */
function parseAdminCommand(text) {
  const value = String(text || '').trim();

  const match = value.match(
    /^\/([a-zA-Z_]+)(?:@\w+)?(?:\s+(.+))?$/
  );

  if (!match) {
    return null;
  }

  return {
    command: match[1].toLowerCase(),
    argument: match[2]?.trim() || ''
  };
}

async function resolveTopicUserId(
  message,
  env,
  argument = ''
) {
  if (argument) {
    const userId = argument
      .split(/\s+/)[0]
      .trim();

    if (/^\d+$/.test(userId)) {
      return userId;
    }

    return null;
  }

  if (!message?.message_thread_id) {
    return null;
  }

  return dbTopicUserGet(
    String(message.message_thread_id),
    env
  );
}

async function sendTopicNotice(
  message,
  text,
  env
) {
  return telegramApi(
    env.BOT_TOKEN,
    'sendMessage',
    {
      chat_id: env.ADMIN_GROUP_ID,
      message_thread_id:
        Number(message.message_thread_id),
      text
    }
  );
}

async function handleAdminCommand(
  message,
  env
) {
  const parsed =
    parseAdminCommand(message.text);

  if (!parsed) {
    return false;
  }

  const senderId =
    String(message.from?.id || '');

  const isAdmin =
    await isAdminUser(senderId, env);

  if (!isAdmin) {
    return true;
  }

  const chatId =
    String(message.chat?.id || '');

  // /testverify [用户ID] - 测试验证流程（仅主管理员）
  // 无参数：重置自身验证状态进入测试模式
  // 有参数：重置指定用户的验证状态，使其下次发消息时重新触发验证
  if (parsed.command === 'testverify') {
    const isPrimary =
      isPrimaryAdmin(senderId, env);

    if (!isPrimary) {
      await telegramApi(
        env.BOT_TOKEN,
        'sendMessage',
        {
          chat_id: chatId,
          text: '⚠️ 此命令仅限主管理员使用。'
        }
      );
      return true;
    }

    const targetUserId =
      parsed.argument || senderId;

    if (!/^\d+$/.test(targetUserId)) {
      await telegramApi(
        env.BOT_TOKEN,
        'sendMessage',
        {
          chat_id: chatId,
          text: '⚠️ 用户 ID 必须为纯数字。\n用法：/testverify [用户ID]'
        }
      );
      return true;
    }

    // 设置测试模式标记
    await setConfig(
      `test_verify_${targetUserId}`,
      '1',
      env
    );

    // 重置用户状态为 NEW
    await dbUserUpdate(
      String(targetUserId),
      { user_state: USER_STATE.NEW },
      env
    );

    const isSelf =
      String(targetUserId) ===
      String(senderId);

    await telegramApi(
      env.BOT_TOKEN,
      'sendMessage',
      {
        chat_id: chatId,
        text: isSelf
          ? '🔧 已进入验证测试模式，您的验证状态已重置。接下来将显示验证流程，验证完成后自动退出测试模式。'
          : `🔧 已重置用户 <code>${escapeHtml(
              targetUserId
            )}</code> 的验证状态（测试模式）。该用户下次发消息时将重新触发验证流程。`,
        parse_mode: 'HTML'
      }
    );

    if (isSelf) {
      await handleStart(chatId, env);
    }

    return true;
  }

  // /reset <用户ID> - 重置用户验证状态（仅主管理员）
  if (parsed.command === 'reset') {
    const isPrimary =
      isPrimaryAdmin(senderId, env);

    if (!isPrimary) {
      await telegramApi(
        env.BOT_TOKEN,
        'sendMessage',
        {
          chat_id: chatId,
          text: '⚠️ 此命令仅限主管理员使用。'
        }
      );
      return true;
    }

    const targetUserId =
      parsed.argument;

    if (!targetUserId) {
      await telegramApi(
        env.BOT_TOKEN,
        'sendMessage',
        {
          chat_id: chatId,
          text:
            '⚠️ 用法：/reset <用户ID>\n' +
            '例如：/reset 8215842959\n\n' +
            '重置后该用户需要重新验证。'
        }
      );
      return true;
    }

    if (!/^\d+$/.test(targetUserId)) {
      await telegramApi(
        env.BOT_TOKEN,
        'sendMessage',
        {
          chat_id: chatId,
          text: '⚠️ 用户 ID 必须为纯数字。'
        }
      );
      return true;
    }

    const targetUser =
      await dbUserGet(
        String(targetUserId),
        env
      );

    if (!targetUser) {
      await telegramApi(
        env.BOT_TOKEN,
        'sendMessage',
        {
          chat_id: chatId,
          text: `❌ 用户 ${escapeHtml(targetUserId)} 不存在。`
        }
      );
      return true;
    }

    await dbUserUpdate(
      String(targetUserId),
      {
        user_state: USER_STATE.NEW,
        is_blocked: false
      },
      env
    );

    // 清除测试模式标记
    await setConfig(
      `test_verify_${targetUserId}`,
      '',
      env
    );

    await telegramApi(
      env.BOT_TOKEN,
      'sendMessage',
      {
        chat_id: chatId,
        text:
          `✅ 已重置用户 <code>${escapeHtml(
            targetUserId
          )}</code> 的验证状态。\n` +
          `该用户下次发消息时将重新触发验证流程。\n\n` +
          `查看指纹：/fp ${escapeHtml(
            targetUserId
          )}`,
        parse_mode: 'HTML'
      }
    );
    return true;
  }

  const allowedCommands = new Set([
  'ban',
  'unban',
  'delete',
  'terminate',
  'card'
]);

  if (!allowedCommands.has(parsed.command)) {
    return false;
  }

  const topicId = String(
    message.message_thread_id || ''
  );

  if (!topicId) {
    await telegramApi(
      env.BOT_TOKEN,
      'sendMessage',
      {
        chat_id: env.ADMIN_GROUP_ID,
        text:
          '⚠️ 这些命令只能在用户话题中使用。'
      }
    );

    return true;
  }

  if (parsed.command === 'ban') {
    const userId =
      await resolveTopicUserId(
        message,
        env,
        parsed.argument
      );

    if (!userId) {
      await sendTopicNotice(
        message,
        '❌ 找不到该话题对应的用户 ID。\n' +
        '也可以使用：/ban 用户ID',
        env
      );

      return true;
    }

    const user =
      await dbUserGetOrCreate(
        userId,
        env
      );

    await dbUserUpdate(
      userId,
      {
        is_blocked: true
      },
      env
    );

    // 同步写入黑名单记录
    try {
      await dbBlacklistAdd(
        env,
        userId,
        '管理员手动封禁',
        'manual'
      );
    } catch (e) {
      console.error(
        '写入黑名单失败：',
        e?.message || e
      );
    }

    await sendTopicNotice(
      message,
      `🚫 已封禁用户 ${userId}。`,
      env
    );

    if (!user.is_blocked) {
      try {
        await telegramApi(
          env.BOT_TOKEN,
          'sendMessage',
          {
            chat_id: userId,
            text:
              '⚠️ 您已被管理员封禁，' +
              '无法继续发送消息。'
          }
        );
      } catch (error) {
        console.error(
          '发送封禁通知失败：',
          error?.message || error
        );
      }
    }

    return true;
  }

  if (parsed.command === 'unban') {
    const userId =
      await resolveTopicUserId(
        message,
        env,
        parsed.argument
      );

    if (!userId) {
      await sendTopicNotice(
        message,
        '❌ 找不到该话题对应的用户 ID。\n' +
        '也可以使用：/unban 用户ID',
        env
      );

      return true;
    }

    await dbUserUpdate(
      userId,
      {
        is_blocked: false,
        block_count: 0
      },
      env
    );

    // 同步移除黑名单记录
    try {
      await dbBlacklistRemove(env, userId);
    } catch (e) {
      console.error(
        '移除黑名单失败：',
        e?.message || e
      );
    }

    await sendTopicNotice(
      message,
      `✅ 已解除用户 ${userId} 的封禁。`,
      env
    );

    try {
      await telegramApi(
        env.BOT_TOKEN,
        'sendMessage',
        {
          chat_id: userId,
          text:
            '✅ 管理员已解除对您的封禁，' +
            '现在可以继续发送消息。'
        }
      );
    } catch (error) {
      console.error(
        '发送解禁通知失败：',
        error?.message || error
      );
    }

    return true;
  }

  if (parsed.command === 'delete') {
    const repliedMessage =
      message.reply_to_message;

    if (!repliedMessage?.message_id) {
      await sendTopicNotice(
        message,
        '⚠️ 请先回复要删除的消息，再发送 /delete。',
        env
      );

      return true;
    }

    try {
      await telegramApi(
        env.BOT_TOKEN,
        'deleteMessage',
        {
          chat_id: env.ADMIN_GROUP_ID,
          message_id:
            repliedMessage.message_id
        }
      );

      await telegramApi(
        env.BOT_TOKEN,
        'deleteMessage',
        {
          chat_id: env.ADMIN_GROUP_ID,
          message_id:
            message.message_id
        }
      );
    } catch (error) {
      await sendTopicNotice(
        message,
        `❌ 删除消息失败：` +
        `${error?.message || error}`,
        env
      );
    }

    return true;
  }
if (parsed.command === 'card') {
  const userId =
    await resolveTopicUserId(
      message,
      env,
      parsed.argument
    );

  if (!userId) {
    await sendTopicNotice(
      message,
      '❌ 找不到当前话题对应的用户 ID。\n' +
      '映射丢失时可以使用：/card 用户ID',
      env
    );

    return true;
  }

  try {
    await dbUserGetOrCreate(userId, env);

    // 指定用户 ID 时，将当前话题重新绑定给该用户。
    if (parsed.argument) {
      await env.TG_BOT_DB.prepare(`
        UPDATE users
        SET
          topic_id = NULL,
          info_card_message_id = NULL,
          topic_creating = 0,
          topic_lock_at = NULL,
          updated_at = ?
        WHERE topic_id = ?
          AND user_id <> ?
      `).bind(
        Math.floor(Date.now() / 1000),
        topicId,
        String(userId)
      ).run();

      await dbUserUpdate(
        userId,
        {
          topic_id: topicId,
          topic_creating: false,
          topic_lock_at: null
        },
        env
      );
    }

    await recreateUserInfoCard(
      userId,
      topicId,
      env
    );

    await sendTopicNotice(
      message,
      `✅ 用户 ${userId} 的资料卡已重新创建。`,
      env
    );
  } catch (error) {
    console.error(
      `重建用户 ${userId} 的资料卡失败：`,
      error?.stack ||
      error?.message ||
      error
    );

    await sendTopicNotice(
      message,
      `❌ 重新创建资料卡失败：` +
      `${error?.message || error}`,
      env
    );
  }

  return true;
}

  if (parsed.command === 'terminate') {
    const userId =
      await resolveTopicUserId(
        message,
        env,
        parsed.argument
      );

    if (!userId) {
      await sendTopicNotice(
        message,
        '❌ 找不到该话题对应的用户 ID。\n' +
        '也可以使用：/terminate 用户ID',
        env
      );

      return true;
    }

    try {
      await telegramApi(
        env.BOT_TOKEN,
        'deleteForumTopic',
        {
          chat_id: env.ADMIN_GROUP_ID,
          message_thread_id:
            Number(topicId)
        }
      );

      await dbUserUpdate(
        userId,
        {
          topic_id: null,
          info_card_message_id: null,
          topic_creating: false,
          topic_lock_at: null
        },
        env
      );
    } catch (error) {
      await sendTopicNotice(
        message,
        `❌ 删除话题失败：` +
        `${error?.message || error}`,
        env
      );
    }

    return true;
  }

  return false;
}

async function handleAdminReply(
  message,
  env
) {
  if (
    !message?.is_topic_message ||
    !message?.message_thread_id
  ) {
    return;
  }

  if (
    String(message.chat.id) !==
    String(env.ADMIN_GROUP_ID)
  ) {
    return;
  }

  if (message.from?.is_bot) {
    return;
  }

  const senderId =
    String(message.from.id);

  const isAdmin =
    await isAdminUser(senderId, env);

  if (!isAdmin) {
  return;
}

if (
  message.text &&
  message.text.trim().startsWith('/')
) {
  const handled =
    await handleAdminCommand(
      message,
      env
    );

  if (handled) {
    return;
  }
}

const topicId =
  String(message.message_thread_id);


  const userId =
    await dbTopicUserGet(
      topicId,
      env
    );

  if (!userId) {
    await telegramApi(
      env.BOT_TOKEN,
      'sendMessage',
      {
        chat_id: env.ADMIN_GROUP_ID,
        message_thread_id:
          Number(topicId),
        text:
          '❌ 找不到该话题对应的用户 ID，无法转发消息。'
      }
    );

    return;
  }

  try {
    await relayAdminMessageToUser(
      message,
      userId,
      env
    );

    if (
      message.text ||
      message.caption
    ) {
      await dbMessageDataPut(
        userId,
        getMessageStorageKey(
          'admin',
          message.message_id
        ),
        {
          text:
            message.text ||
            message.caption ||
            '',
          date: message.date
        },
        env
      );
    }
  } catch (error) {
    console.error(
      '管理员消息转发失败：',
      error?.message || error
    );

    await telegramApi(
      env.BOT_TOKEN,
      'sendMessage',
      {
        chat_id: env.ADMIN_GROUP_ID,
        message_thread_id:
          Number(topicId),
        text:
          `❌ 转发消息给用户 ${userId} 失败：` +
          `${error?.message || error}`
      }
    );
  }
}

/* -------------------------------------------------------------------------- */
/*                               编辑消息处理                                    */
/* -------------------------------------------------------------------------- */

async function handleRelayEditedMessage(
  editedMessage,
  env
) {
  if (!editedMessage?.from?.id) return;

  const userId =
    String(editedMessage.from.id);

  const user =
    await dbUserGetOrCreate(
      userId,
      env
    );

  if (
    user.is_blocked ||
    user.user_state !==
      USER_STATE.VERIFIED ||
    !user.topic_id
  ) {
    return;
  }

  const text =
    getMessageText(editedMessage);

  const hitKeyword =
    await findBlockKeyword(text, env);

  if (hitKeyword) {
    await handleBlockedKeyword(
      userId,
      String(editedMessage.chat.id),
      hitKeyword,
      env
    );

    return;
  }

  const filterResult =
    await checkForwardFilters(
      editedMessage,
      env
    );

  if (!filterResult.ok) {
    try {
      await telegramApi(
        env.BOT_TOKEN,
        'sendMessage',
        {
          chat_id:
            String(editedMessage.chat.id),
          text:
            `⚠️ 编辑后的消息未通过过滤：` +
            `${filterResult.reason}`
        }
      );
    } catch (error) {
      console.error(
        '发送编辑过滤提示失败：',
        error?.message || error
      );
    }

    return;
  }

  const storageKey =
    getMessageStorageKey(
      'user',
      editedMessage.message_id
    );

  const stored =
    await dbMessageDataGet(
      userId,
      storageKey,
      env
    );

  const originalText =
    stored?.text ||
    '[原始内容无法获取或不是文本内容]';

  const originalDate = stored?.date
    ? formatTimestamp(stored.date)
    : '[发送时间无法获取]';

  const newContent =
    editedMessage.text ||
    editedMessage.caption ||
    '[非文本或媒体内容]';

  await dbMessageDataPut(
    userId,
    storageKey,
    {
      text: newContent,
      date:
        editedMessage.edit_date ||
        editedMessage.date
    },
    env
  );

  const notificationText = `
⚠️ <b>用户消息已修改</b>

<b>原消息发送时间：</b>
<code>${escapeHtml(originalDate)}</code>

<b>原始内容：</b>
${escapeHtml(originalText)}

<b>修改后的内容：</b>
${escapeHtml(newContent)}
  `.trim();

  try {
    await maybeAutoRefreshUserCard(
      editedMessage,
      env
    );

    await telegramApi(
      env.BOT_TOKEN,
      'sendMessage',
      {
        chat_id: env.ADMIN_GROUP_ID,
        message_thread_id:
          Number(user.topic_id),
        text: notificationText,
        parse_mode: 'HTML'
      }
    );
  } catch (error) {
    console.error(
      '处理用户编辑消息失败：',
      error?.message || error
    );
  }
}

async function handleAdminEditedReply(
  editedMessage,
  env
) {
  if (
    !editedMessage?.is_topic_message ||
    !editedMessage?.message_thread_id
  ) {
    return;
  }

  if (
    String(editedMessage.chat.id) !==
    String(env.ADMIN_GROUP_ID)
  ) {
    return;
  }

  if (editedMessage.from?.is_bot) {
    return;
  }

  const senderId =
    String(editedMessage.from.id);

  const isAdmin =
    await isAdminUser(senderId, env);

  if (!isAdmin) {
    return;
  }

  const topicId =
    String(editedMessage.message_thread_id);

  const userId =
    await dbTopicUserGet(
      topicId,
      env
    );

  if (!userId) {
    return;
  }

  const storageKey =
    getMessageStorageKey(
      'admin',
      editedMessage.message_id
    );

  const stored =
    await dbMessageDataGet(
      userId,
      storageKey,
      env
    );

  if (!stored) {
    return;
  }

  const newText =
    editedMessage.text ||
    editedMessage.caption ||
    '[媒体内容]';

  const originalTime =
    formatTimestamp(stored.date);

  const editTime =
    formatTimestamp(
      editedMessage.edit_date ||
      editedMessage.date
    );

  const notificationText = `
⚠️ <b>管理员编辑了之前的回复</b>

<b>原发送或上次编辑时间：</b>
<code>${escapeHtml(originalTime)}</code>

<b>本次编辑时间：</b>
<code>${escapeHtml(editTime)}</code>

<b>原消息内容：</b>
${escapeHtml(stored.text)}

<b>新消息内容：</b>
${escapeHtml(newText)}
  `.trim();

  try {
    await telegramApi(
      env.BOT_TOKEN,
      'sendMessage',
      {
        chat_id: userId,
        text: notificationText,
        parse_mode: 'HTML'
      }
    );

    await dbMessageDataPut(
      userId,
      storageKey,
      {
        text: newText,
        date:
          editedMessage.edit_date ||
          editedMessage.date
      },
      env
    );
  } catch (error) {
    console.error(
      '处理管理员编辑消息失败：',
      error?.message || error
    );
  }
}

/* -------------------------------------------------------------------------- */
/*                             配置列表和删除处理                                 */
/* -------------------------------------------------------------------------- */

async function handleConfigMenu(
  chatId,
  messageId,
  key,
  env
) {
  if (key === 'base') {
    return showBaseMenu(
      chatId,
      env,
      messageId
    );
  }

  if (key === 'autoreply') {
    return showAutoReplyMenu(
      chatId,
      env,
      messageId
    );
  }

  if (key === 'keyword') {
    return showKeywordMenu(
      chatId,
      env,
      messageId
    );
  }

  if (key === 'filter') {
    return showFilterMenu(
      chatId,
      env,
      messageId
    );
  }

  if (key === 'authorized') {
    return showAuthorizedMenu(
      chatId,
      env,
      messageId
    );
  }

  return showMainMenu(
    chatId,
    env,
    messageId
  );
}

async function handleRuleList(
  chatId,
  messageId,
  type,
  pageValue,
  env
) {
  let rows = [];
  let text = '';

  if (type === 'keyword_responses') {
    const rules =
      await getAutoReplyRules(env);

    const pageInfo =
      clampPage(pageValue, rules.length);

    const start =
      pageInfo.page * RULE_PAGE_SIZE;

    const pageRules = rules.slice(
      start,
      start + RULE_PAGE_SIZE
    );

    text =
      `📋 <b>自动回复规则列表</b>\n\n` +
      `共 ${rules.length} 条，` +
      `第 ${pageInfo.page + 1}/` +
      `${pageInfo.totalPages} 页`;

    rows = pageRules.map((rule, index) => {
  const absoluteIndex = start + index;

  const keywordPreview = Array.from(
    String(rule.keywords || '')
  )
    .slice(0, 25)
    .join('');

  return [
    {
      text:
        `删除 ${absoluteIndex + 1}. ` +
        `${keywordPreview}`,
      callback_data:
        `config:delete:keyword_responses:` +
        `${absoluteIndex}:${pageInfo.page}`
    }
  ];
});


    const navigation = [];

    if (pageInfo.page > 0) {
      navigation.push({
        text: '⬅️ 上一页',
        callback_data:
          `config:list:keyword_responses:` +
          `${pageInfo.page - 1}`
      });
    }

    if (
      pageInfo.page <
      pageInfo.totalPages - 1
    ) {
      navigation.push({
        text: '下一页 ➡️',
        callback_data:
          `config:list:keyword_responses:` +
          `${pageInfo.page + 1}`
      });
    }

    if (navigation.length) {
      rows.push(navigation);
    }

    rows.push([
      {
        text: '⬅️ 返回',
        callback_data:
          'config:menu:autoreply'
      }
    ]);
  } else if (
    type === 'block_keywords'
  ) {
    const keywords =
      await getBlockKeywords(env);

    const pageInfo =
      clampPage(pageValue, keywords.length);

    const start =
      pageInfo.page * RULE_PAGE_SIZE;

    const pageKeywords = keywords.slice(
      start,
      start + RULE_PAGE_SIZE
    );

    text =
      `📋 <b>屏蔽关键词列表</b>\n\n` +
      `共 ${keywords.length} 条，` +
      `第 ${pageInfo.page + 1}/` +
      `${pageInfo.totalPages} 页`;

    rows = pageKeywords.map(
      (keyword, index) => [
        {
          text:
            `删除 ${start + index + 1}. ` +
            `${String(keyword).slice(0, 25)}`,
          callback_data:
            `config:delete:block_keywords:` +
            `${start + index}:${pageInfo.page}`
        }
      ]
    );

    const navigation = [];

    if (pageInfo.page > 0) {
      navigation.push({
        text: '⬅️ 上一页',
        callback_data:
          `config:list:block_keywords:` +
          `${pageInfo.page - 1}`
      });
    }

    if (
      pageInfo.page <
      pageInfo.totalPages - 1
    ) {
      navigation.push({
        text: '下一页 ➡️',
        callback_data:
          `config:list:block_keywords:` +
          `${pageInfo.page + 1}`
      });
    }

    if (navigation.length) {
      rows.push(navigation);
    }

    rows.push([
      {
        text: '⬅️ 返回',
        callback_data:
          'config:menu:keyword'
      }
    ]);
  } else {
    return;
  }

  await renderMenu(env, {
    chatId,
    messageId,
    text,
    reply_markup: {
      inline_keyboard: rows
    }
  });
}

async function handleRuleDelete(
  chatId,
  messageId,
  type,
  value,
  page,
  env
) {
  if (type === 'keyword_responses') {
  const rules =
    await getAutoReplyRules(env);

  const index = Number(value);

  if (
    Number.isInteger(index) &&
    index >= 0 &&
    index < rules.length
  ) {
    rules.splice(index, 1);

    await setConfig(
      'keyword_responses',
      JSON.stringify(rules),
      env
    );
  }

  return handleRuleList(
    chatId,
    messageId,
    type,
    page,
    env
  );
}


  if (type === 'block_keywords') {
    const keywords =
      await getBlockKeywords(env);

    const index = Number(value);

    if (
      Number.isInteger(index) &&
      index >= 0 &&
      index < keywords.length
    ) {
      keywords.splice(index, 1);

      await setConfig(
        'block_keywords',
        JSON.stringify(keywords),
        env
      );
    }

    return handleRuleList(
      chatId,
      messageId,
      type,
      page,
      env
    );
  }
}

/* -------------------------------------------------------------------------- */
/*                              Callback Query                                 */
/* -------------------------------------------------------------------------- */

async function answerCallback(
  callbackId,
  env,
  text = '',
  showAlert = false
) {
  try {
    await telegramApi(
      env.BOT_TOKEN,
      'answerCallbackQuery',
      {
        callback_query_id: callbackId,
        text,
        show_alert: showAlert
      }
    );
  } catch (error) {
    console.error(
      '回答 Callback Query 失败：',
      error?.message || error
    );
  }
}

async function handleConfigCallback(
  callbackQuery,
  env
) {
  const chatId =
    String(callbackQuery.from.id);

  const message =
    callbackQuery.message;

  if (!message?.message_id) {
    await answerCallback(
      callbackQuery.id,
      env,
      '菜单消息不存在。',
      true
    );

    return;
  }

  if (!isPrimaryAdmin(chatId, env)) {
    await answerCallback(
      callbackQuery.id,
      env,
      '只有主管理员可以修改配置。',
      true
    );

    return;
  }

  const parts =
    String(callbackQuery.data || '')
      .split(':');

  const action = parts[1] || '';
  const key = parts[2] || '';
  const value = parts[3];
  const extra = parts[4];

  await answerCallback(
    callbackQuery.id,
    env,
    '处理中…'
  );

  if (action === 'menu') {
    await handleConfigMenu(
      chatId,
      message.message_id,
      key,
      env
    );

    return;
  }

  if (action === 'toggle') {
    const allowedToggleKeys = new Set([
      'enable_image_forwarding',
      'enable_link_forwarding',
      'enable_text_forwarding',
      'enable_audio_forwarding',
      'enable_sticker_forwarding',
      'enable_user_forwarding',
      'enable_group_forwarding',
      'enable_channel_forwarding'
    ]);

    if (!allowedToggleKeys.has(key)) {
      return;
    }

    await setConfig(
      key,
      value === 'true'
        ? 'true'
        : 'false',
      env
    );

    await showFilterMenu(
      chatId,
      env,
      message.message_id
    );

    return;
  }

  if (action === 'edit') {
    const editableKeys = new Set([
      'welcome_msg',
      'verif_q',
      'verif_a',
      'block_threshold',
      'authorized_admins'
    ]);

    if (!editableKeys.has(key)) {
      return;
    }

    await setAdminState(
      chatId,
      {
        action: 'awaiting_input',
        key
      },
      env
    );

    let prompt =
      `请发送新的 ${key} 值：`;

    if (key === 'welcome_msg') {
      prompt = '请发送新的欢迎消息：';
    } else if (key === 'verif_q') {
      prompt = '请发送新的验证问题：';
    } else if (key === 'verif_a') {
      prompt =
        '请发送新的验证答案；多个答案使用 | 分隔：';
    } else if (
      key === 'block_threshold'
    ) {
      prompt =
        '请发送新的屏蔽次数阈值（1～100）：';
    } else if (
      key === 'authorized_admins'
    ) {
      prompt =
        '请发送协管员 ID 列表，多个 ID 使用英文逗号分隔：';
    }

    await renderMenu(env, {
      chatId,
      messageId: message.message_id,
      text:
        `${prompt}\n\n` +
        `状态将在 10 分钟后过期。\n` +
        `发送 /cancel 取消。`,
      parse_mode: undefined
    });

    return;
  }

  if (action === 'add') {
    if (
      ![
        'keyword_responses',
        'block_keywords'
      ].includes(key)
    ) {
      return;
    }

    await setAdminState(
      chatId,
      {
        action: 'awaiting_input',
        key: `${key}_add`
      },
      env
    );

    const prompt =
      key === 'keyword_responses'
        ? '请发送新的自动回复规则：\n' +
          '格式：关键词表达式===回复内容'
        : '请发送新的屏蔽关键词表达式：';

    await renderMenu(env, {
      chatId,
      messageId: message.message_id,
      text:
        `${prompt}\n\n` +
        `状态将在 10 分钟后过期。\n` +
        `发送 /cancel 取消。`,
      parse_mode: undefined
    });

    return;
  }

  if (action === 'list') {
    await handleRuleList(
      chatId,
      message.message_id,
      key,
      value || 0,
      env
    );

    return;
  }

  if (action === 'delete') {
    await handleRuleDelete(
      chatId,
      message.message_id,
      key,
      value,
      extra || 0,
      env
    );

    return;
  }

  if (
    action === 'clear' &&
    key === 'authorized_admins'
  ) {
    await setConfig(
      'authorized_admins',
      '[]',
      env
    );

    await showAuthorizedMenu(
      chatId,
      env,
      message.message_id
    );
  }
}

async function handleUserCardCallback(
  callbackQuery,
  env
) {
  const message =
    callbackQuery.message;

  if (
    !message ||
    String(message.chat.id) !==
      String(env.ADMIN_GROUP_ID)
  ) {
    await answerCallback(
      callbackQuery.id,
      env,
      '该按钮只能在管理群中使用。',
      true
    );

    return;
  }

  const [
    action,
    targetUserId
  ] = String(
    callbackQuery.data || ''
  ).split(':');

  const allowedActions = new Set([
    'block',
    'unblock',
    'mute',
    'unmute',
    'pin_card',
    'refresh_card'
  ]);

  if (
    !allowedActions.has(action) ||
    !/^\d+$/.test(
      String(targetUserId || '')
    )
  ) {
    await answerCallback(
      callbackQuery.id,
      env,
      '无效操作。',
      true
    );

    return;
  }

  let user =
    await dbUserGetOrCreate(
      targetUserId,
      env
    );

  if (action === 'pin_card') {
    try {
      await telegramApi(
        env.BOT_TOKEN,
        'pinChatMessage',
        {
          chat_id: message.chat.id,
          message_id:
            message.message_id,
          disable_notification: true
        }
      );

      await dbUserUpdate(
        targetUserId,
        {
          info_card_message_id:
            String(message.message_id)
        },
        env
      );

      await answerCallback(
        callbackQuery.id,
        env,
        '✅ 已置顶资料卡。'
      );
    } catch (error) {
      await answerCallback(
        callbackQuery.id,
        env,
        `❌ 置顶失败：` +
        `${error?.message || error}`,
        true
      );
    }

    return;
  }

  if (action === 'refresh_card') {
    try {
      const chatObject =
        await telegramApi(
          env.BOT_TOKEN,
          'getChat',
          {
            chat_id: targetUserId
          }
        );

      const result =
        await refreshUserInfoCard(
          targetUserId,
          chatObject,
          env,
          true
        );

      let tip = '✅ 资料卡已刷新。';

      if (!result.updated) {
        if (result.reason === 'missing_card') {
          tip = '⚠️ 找不到资料卡消息。';
        } else if (
          result.reason === 'not_modified'
        ) {
          tip = '✅ 资料卡已是最新，无需刷新。';
        }
      }


      await answerCallback(
        callbackQuery.id,
        env,
        tip
      );
    } catch (error) {
      console.error(
        '刷新资料卡失败：',
        error?.message || error
      );

      await answerCallback(
        callbackQuery.id,
        env,
        `❌ 刷新失败：` +
        `${error?.message || error}`,
        true
      );
    }

    return;
  }

  try {
    if (
      action === 'block' ||
      action === 'unblock'
    ) {
      await dbUserUpdate(
        targetUserId,
        {
          is_blocked:
            action === 'block'
        },
        env
      );
    }

    if (
      action === 'mute' ||
      action === 'unmute'
    ) {
      await dbUserUpdate(
        targetUserId,
        {
          is_muted:
            action === 'mute'
        },
        env
      );
    }

    user = await dbUserGetOrCreate(
      targetUserId,
      env
    );

    const usernameRaw =
      user.user_info?.username_raw || '';

    await telegramApi(
      env.BOT_TOKEN,
      'editMessageReplyMarkup',
      {
        chat_id: message.chat.id,
        message_id:
          message.message_id,
        reply_markup:
          getInfoCardButtons(
            targetUserId,
            user.is_blocked,
            user.is_muted,
            usernameRaw
          )
      }
    );

    let toast = '✅ 操作成功。';

    if (action === 'block') {
      toast = '🚫 已屏蔽该用户。';
    }

    if (action === 'unblock') {
      toast = '✅ 已解除屏蔽。';
    }

    if (action === 'mute') {
      toast = '🔕 已静音通知。';
    }

    if (action === 'unmute') {
      toast = '🔔 已恢复通知。';
    }

    await answerCallback(
      callbackQuery.id,
      env,
      toast
    );
  } catch (error) {
    console.error(
      `处理 ${action} 失败：`,
      error?.message || error
    );

    await answerCallback(
      callbackQuery.id,
      env,
      '❌ 操作失败，请重试。',
      true
    );
  }
}

async function handleCallbackQuery(
  callbackQuery,
  env
) {
  if (!callbackQuery?.from?.id) {
    return;
  }

  const senderId =
    String(callbackQuery.from.id);

  const isAdmin =
    await isAdminUser(senderId, env);

  if (!isAdmin) {
    await answerCallback(
      callbackQuery.id,
      env,
      '您无权执行该操作。',
      true
    );

    return;
  }

  const data =
    String(callbackQuery.data || '');

  if (data.startsWith('config:')) {
    await handleConfigCallback(
      callbackQuery,
      env
    );

    return;
  }

  await handleUserCardCallback(
    callbackQuery,
    env
  );
}

/* -------------------------------------------------------------------------- */
/*                               Update 入口                                    */
/* -------------------------------------------------------------------------- */

async function handleUpdate(update, env) {
  const accepted = await claimUpdate(
    update?.update_id,
    env
  );

  if (!accepted) {
    console.log(
      '忽略重复 Update：',
      update?.update_id
    );

    return;
  }

  if (update.message) {
    if (
      update.message.chat.type ===
      'private'
    ) {
      await handlePrivateMessage(
        update.message,
        env
      );
    } else if (
      String(update.message.chat.id) ===
      String(env.ADMIN_GROUP_ID)
    ) {
      await handleAdminReply(
        update.message,
        env
      );
    }

    return;
  }

  if (update.edited_message) {
    if (
      update.edited_message.chat.type ===
      'private'
    ) {
      await handleRelayEditedMessage(
        update.edited_message,
        env
      );
    } else if (
      String(
        update.edited_message.chat.id
      ) === String(env.ADMIN_GROUP_ID)
    ) {
      await handleAdminEditedReply(
        update.edited_message,
        env
      );
    }

    return;
  }

  if (update.callback_query) {
    await handleCallbackQuery(
      update.callback_query,
      env
    );
  }
}

/* -------------------------------------------------------------------------- */
/*                    Turnstile 验证页 + 后台静默指纹采集                         */
/* -------------------------------------------------------------------------- */

function renderVerifyPage(
  sessionId,
  siteKey,
  botUsername,
  verifQ
) {
  // 将验证问题注入前端（转义引号和反斜杠，防止 XSS）
  const qaQuestion = verifQ && verifQ.trim()
    ? verifQ.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    : '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Just a moment...</title>
<!-- 内联背景色，防止白屏闪烁 -->
<style>html,body{background:#1a1a1a!important;margin:0;padding:0}</style>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #1a1a1a; color: #e5e5e5; min-height: 100vh;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    padding: 20px; overflow: hidden;
  }
  /* 模拟 Cloudflare 经典挑战卡片 */
  .cf-box {
    background: #2c2c2c; border-radius: 12px; padding: 40px 32px 32px;
    width: 100%; max-width: 400px; text-align: center;
    box-shadow: 0 4px 24px rgba(0,0,0,0.4); position: relative;
  }
  /* Cloudflare 橙色云朵 logo */
  .cf-logo { width: 52px; height: 52px; margin: 0 auto 20px; }
  .cf-title { font-size: 18px; font-weight: 600; color: #e5e5e5; margin-bottom: 8px; }
  .cf-sub { font-size: 14px; color: #888; line-height: 1.6; margin-bottom: 24px; }
  /* 加载旋转动画 */
  .cf-spinner {
    width: 40px; height: 40px; margin: 0 auto 20px;
    border: 3px solid #444; border-top-color: #f48120; border-radius: 50%;
    animation: cf-spin .7s linear infinite;
  }
  @keyframes cf-spin { to { transform: rotate(360deg); } }
  /* Turnstile 容器 */
  #ts-wrap {
    display: flex; justify-content: center; align-items: center;
    min-height: 65px; width: 100%; margin-top: 8px;
  }
  #ts-wrap iframe { max-width: 100% !important; border: none !important; }
  /* 底部 brand */
  .cf-brand { margin-top: 24px; font-size: 13px; color: #555; }
  .cf-brand span { color: #f48120; font-weight: 600; }
  #status { margin-top: 12px; font-size: 13px; min-height: 18px; color: #888; }
  .err { color: #f87171; }
  /* 成功页 */
  #page-ok { text-align: center; }
  .ok-icon { font-size: 52px; margin-bottom: 16px; }
  .ok-text { color: #4ade80; font-size: 18px; font-weight: 600; margin-bottom: 8px; }
  .ok-hint { font-size: 14px; color: #888; }
  .hidden { display: none !important; }
</style>
<script src="https://telegram.org/js/telegram-web-app.js" async></script>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTsLoad" async defer></script>
</head>
<body>
<div id="page-loading" class="cf-box">
  <!-- Cloudflare 橙色云朵 SVG logo -->
  <svg class="cf-logo" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M31.5 20.5c.3-1.7-.2-3.4-1.3-4.7-1.1-1.3-2.7-2-4.5-2h-.2c-.5-2.2-2.5-3.8-4.8-3.8-1.4 0-2.7.6-3.6 1.5-.9-.6-2-1-3.1-1-2.9 0-5.3 2.3-5.4 5.1-2.2.6-3.8 2.6-3.8 4.9 0 .3 0 .6.1.8.1.2.2.3.4.3h26c.2 0 .4-.1.5-.3.1-.2.1-.4.1-.5z" fill="#fff"/>
    <path d="M37.8 26.2c-.5-1.2-1.5-2.1-2.7-2.5.2-.6.3-1.2.3-1.9 0-2.8-2.3-5.2-5.2-5.2-.2 0-.4 0-.6.1-.6-2.6-2.9-4.5-5.6-4.5-1.7 0-3.3.7-4.4 1.9-.9-.5-1.9-.8-3-.8-3.2 0-5.9 2.5-6.2 5.6-2.4.7-4.2 2.9-4.2 5.6 0 .4 0 .7.1 1.1.1.3.3.5.6.5h28.4c.3 0 .5-.2.6-.4.1-.3.1-.5.1-.8 0-.2 0-.4-.1-.6z" fill="#f48120"/>
    <path d="M37.8 26.2c-.5-1.2-1.5-2.1-2.7-2.5.2-.6.3-1.2.3-1.9 0-2.8-2.3-5.2-5.2-5.2-.2 0-.4 0-.6.1-.6-2.6-2.9-4.5-5.6-4.5-1.7 0-3.3.7-4.4 1.9-.9-.5-1.9-.8-3-.8-3.2 0-5.9 2.5-6.2 5.6-2.4.7-4.2 2.9-4.2 5.6 0 .4 0 .7.1 1.1.1.3.3.5.6.5h28.4c.3 0 .5-.2.6-.4.1-.3.1-.5.1-.8 0-.2 0-.4-.1-.6z" fill="#faad3f" opacity="0.3"/>
  </svg>
  <div class="cf-title">Verifying you are human</div>
  <div class="cf-sub">This may take a few seconds</div>
  <div class="cf-spinner" id="cf-spin"></div>
  <div id="ts-wrap"><div id="ts-container"></div></div>
  ${qaQuestion ? `
  <div id="qa-wrap" style="width:100%;margin-top:16px;text-align:left;">
    <label style="font-size:14px;color:#ccc;display:block;margin-bottom:6px;">${escapeHtml(qaQuestion)}</label>
    <input id="qa-answer" type="text" autocomplete="off" placeholder="请输入答案"
      style="width:100%;padding:10px 12px;border-radius:8px;border:1px solid #555;background:#1a1a1a;color:#e5e5e5;font-size:15px;outline:none;" />
  </div>` : ''}
  <div id="status"></div>
  <div class="cf-brand"><span>cloudflare</span></div>
</div>
<div id="page-ok" class="cf-box hidden">
  <div class="ok-icon">✅</div>
  <div class="ok-text">验证完成</div>
  <div class="ok-hint">请返回 Telegram 继续操作</div>
</div>
<script>
  // 设置 WebApp 背景色（不等 defer 脚本，直接轮询检测）
  (function setBg() {
    if (window.Telegram && window.Telegram.WebApp) {
      try {
        window.Telegram.WebApp.setBackgroundColor('#1a1a1a');
        window.Telegram.WebApp.setHeaderColor('#1a1a1a');
        window.Telegram.WebApp.expand();
      } catch(e) {}
    } else {
      setTimeout(setBg, 30);
    }
  })();

  const FP = { canvas: "", webgl: "", audio: "", os: "", cpu: "", screen: "", fonts: "" };

  // 预采集指纹：页面加载即开始，与 Turnstile 验证并行，减少总等待时间
  var _fpPromise = null;
  function preCollectFingerprint() {
    if (!_fpPromise) {
      _fpPromise = collectAll();
    }
    return _fpPromise;
  }

  async function collectCanvas() {
    try {
      const c = document.createElement("canvas");
      c.width = 240; c.height = 60;
      const ctx = c.getContext("2d");
      ctx.textBaseline = "top"; ctx.font = "14px Arial";
      ctx.fillStyle = "#f60"; ctx.fillRect(0, 0, 100, 30);
      ctx.fillStyle = "#069"; ctx.fillText("tgbot-d1-fp", 2, 2);
      ctx.fillStyle = "rgba(102,204,0,0.7)"; ctx.fillText("tgbot-d1-fp", 4, 4);
      FP.canvas = c.toDataURL();
    } catch (e) { FP.canvas = "err"; }
  }

  async function collectWebGL() {
    try {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl") || c.getContext("experimental-webgl");
      if (!gl) { FP.webgl = "n/a"; return; }
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      const vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
      const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      FP.webgl = vendor + "|" + renderer;
    } catch (e) { FP.webgl = "err"; }
  }

  async function collectAudio() {
    try {
      const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!AC) { FP.audio = "n/a"; return; }
      const ac = new AC(1, 44100, 44100);
      const osc = ac.createOscillator(); osc.type = "triangle"; osc.frequency.value = 1000;
      const comp = ac.createDynamicsCompressor();
      osc.connect(comp); comp.connect(ac.destination);
      osc.start(0);
      const buf = await ac.startRendering();
      let sum = 0;
      const data = buf.getChannelData(0);
      for (let i = 4500; i < 5000; i++) sum += Math.abs(data[i]);
      FP.audio = sum.toString();
    } catch (e) { FP.audio = "err"; }
  }

  function collectOS() {
    const ua = navigator.userAgent;
    let os = "Unknown";
    if (/Windows NT 10/.test(ua)) os = "Windows 10/11";
    else if (/Windows NT 6\\.3/.test(ua)) os = "Windows 8.1";
    else if (/Windows NT 6\\.1/.test(ua)) os = "Windows 7";
    else if (/Android/.test(ua)) os = "Android " + (ua.match(/Android ([\\d.]+)/) || [,""])[1];
    else if (/iPhone|iPad|iPod/.test(ua)) os = "iOS " + (ua.match(/OS ([\\d_]+)/) || [,""])[1].replace(/_/g,".");
    else if (/Mac OS X/.test(ua)) os = "macOS " + (ua.match(/Mac OS X ([\\d_]+)/) || [,""])[1].replace(/_/g,".");
    else if (/Linux/.test(ua)) os = "Linux";
    FP.os = os;
  }

  function collectCPU() { FP.cpu = String(navigator.hardwareConcurrency || "unknown"); }

  function collectScreen() {
    FP.screen = screen.width + "x" + screen.height + "x" + (screen.colorDepth || 0) + "x" + (window.devicePixelRatio || 1);
  }

  async function collectFonts() {
    try {
      const test = "mmmmmmmmmmlli";
      const size = "72px";
      const baseline = ["monospace", "sans-serif", "serif"];
      const span = document.createElement("span");
      span.style.position = "absolute"; span.style.left = "-9999px"; span.style.fontSize = size;
      span.textContent = test;
      const baselineW = {};
      for (const b of baseline) {
        span.style.fontFamily = b;
        document.body.appendChild(span);
        baselineW[b] = { w: span.offsetWidth, h: span.offsetHeight };
        document.body.removeChild(span);
      }
      const fonts = ["Arial","Verdana","Helvetica","Times New Roman","Courier New","Georgia",
                     "Comic Sans MS","Trebuchet MS","Impact","Segoe UI","Microsoft YaHei",
                     "PingFang SC","SimSun","SimHei","Roboto","Consolas","Menlo","SF Pro"];
      const detected = [];
      for (const f of fonts) {
        let diff = false;
        for (const b of baseline) {
          span.style.fontFamily = "'" + f + "'," + b;
          document.body.appendChild(span);
          if (span.offsetWidth !== baselineW[b].w || span.offsetHeight !== baselineW[b].h) { diff = true; }
          document.body.removeChild(span);
        }
        if (diff) detected.push(f);
      }
      FP.fonts = detected.join(",");
    } catch (e) { FP.fonts = "err"; }
  }

  async function collectWebRTC() {
    return new Promise((resolve) => {
      const RTC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
      if (!RTC) { resolve({ ip: null, error: "n/a" }); return; }
      const pc = new RTC({ iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun.miwifi.com:3478" }
      ] });
      let foundIp = null;
      const ipRegex = /([0-9]{1,3}(\\.[0-9]{1,3}){3}|[a-f0-9]{1,4}(:[a-f0-9]{1,4}){7})/i;
      const isPublic = (ip) => {
        if (/^(10\\.|192\\.168\\.|172\\.(1[6-9]|2\\d|3[01])\\.|127\\.|169\\.254\\.|::1$|fc00:|fe80:)/i.test(ip)) return false;
        return true;
      };
      pc.onicecandidate = (e) => {
        if (!e.candidate) { try { pc.close(); } catch {} resolve({ ip: foundIp, error: null }); return; }
        const m = e.candidate.candidate.match(ipRegex);
        if (m) { const ip = m[1]; if (isPublic(ip) && !foundIp) foundIp = ip; }
      };
      pc.createDataChannel("");
      pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => resolve({ ip: null, error: "err" }));
      setTimeout(() => { try { pc.close(); } catch {} resolve({ ip: foundIp, error: null }); }, 2500);
    });
  }

  async function collectAll() {
    collectOS(); collectCPU(); collectScreen();
    const [_, webrtc] = await Promise.all([
      Promise.all([collectCanvas(), collectWebGL(), collectAudio(), collectFonts()]),
      collectWebRTC()
    ]);
    return { ...FP, webrtc_ip: webrtc.ip, webrtc_error: webrtc.error };
  }

  async function submitSilent(token) {
    const st = document.getElementById("status");
    // 问答验证：配置了验证问题时必须填写答案
    var qaQuestion = '${qaQuestion}';
    var answer = '';
    if (qaQuestion) {
      var qaInput = document.getElementById("qa-answer");
      answer = (qaInput && qaInput.value || '').trim();
      if (!answer) {
        st.innerHTML = '<span class="err">请先回答上方问题</span>';
        try { turnstile.reset(); } catch(e) {}
        return;
      }
    }
    st.textContent = "处理中…";
    try {
      // 复用预采集的指纹结果（与 Turnstile 验证并行已完成）
      const fp = await preCollectFingerprint();
      // 获取 Telegram WebApp initData 用于身份绑定校验
      var initData = '';
      try {
        if (window.Telegram && window.Telegram.WebApp) {
          initData = window.Telegram.WebApp.initData || '';
        }
      } catch(e) {}
      const res = await fetch("/api/verify/" + "${sessionId}", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, fingerprint: fp, initData: initData, answer: answer })
      });
      const data = await res.json();
      if (data.ok) {
        document.getElementById("page-loading").classList.add("hidden");
        document.getElementById("page-ok").classList.remove("hidden");
        document.title = "完成";
        setTimeout(function() {
          try {
            if (window.Telegram && window.Telegram.WebApp) {
              window.Telegram.WebApp.close();
            }
          } catch(e) {}
        }, 1500);
      } else {
        st.innerHTML = '<span class="err">验证失败，请重试</span>';
      }
    } catch (e) {
      st.innerHTML = '<span class="err">网络错误，请重试</span>';
    }
  }

  // 页面加载即启动指纹预采集，与 Turnstile 验证并行执行
  preCollectFingerprint();

  window.onTsLoad = function() {
    var container = document.getElementById("ts-container");
    if (!container) {
      setTimeout(window.onTsLoad, 100);
      return;
    }
    try {
      turnstile.render("#ts-container", {
        sitekey: "${siteKey}",
        theme: "dark",
        size: "normal",
        appearance: "always",
        callback: function(token) {
          // Turnstile 通过后隐藏 spinner，显示处理状态
          var spin = document.getElementById("cf-spin");
          if (spin) spin.style.display = "none";
          submitSilent(token);
        },
        "error-callback": function() {
          document.getElementById("status").innerHTML = '<span class="err">加载失败，请重试</span>';
        },
        "timeout-callback": function() {
          try { turnstile.reset(); } catch(e) {}
        }
      });
    } catch(e) {
      document.getElementById("status").innerHTML = '<span class="err">加载失败，请刷新重试</span>';
    }
  };
</script>
</body>
</html>`;
}

// 修复：原实现无重试，网络抖动直接导致验证失败
async function verifyTurnstile(
  token,
  env,
  attempt = 0
) {
  if (!token) return false;
  try {
    const res = await fetch(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          secret: env.TURNSTILE_SECRET_KEY,
          response: token
        }),
        signal: AbortSignal.timeout(10000)
      }
    );
    const data = await res.json();
    return data.success === true;
  } catch (error) {
    if (attempt < 2) {
      await sleep(500 * (attempt + 1));
      return verifyTurnstile(
        token,
        env,
        attempt + 1
      );
    }
    console.error(
      'Turnstile 校验失败：',
      error?.message || error
    );
    return false;
  }
}

// 修复：校验 Telegram WebApp initData 的 HMAC 签名，绑定验证会话与提交者身份
async function validateWebAppData(initData, botToken) {
  if (!initData || !botToken) return null;

  let params;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return null;
  }

  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  // data_check_string：按 key 字典序排列的 key=value，用换行连接
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');

  const enc = new TextEncoder();

  try {
    // secret_key = HMAC_SHA256("WebAppData", bot_token)
    const secretKeySeed =
      await crypto.subtle.importKey(
        'raw',
        enc.encode('WebAppData'),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
    const secretKeyBuf =
      await crypto.subtle.sign(
        'HMAC',
        secretKeySeed,
        enc.encode(botToken)
      );
    const secretKey =
      await crypto.subtle.importKey(
        'raw',
        secretKeyBuf,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
    // hash = HMAC_SHA256(secret_key, data_check_string)
    const calcBuf = await crypto.subtle.sign(
      'HMAC',
      secretKey,
      enc.encode(dataCheckString)
    );
    const calcHash = [...new Uint8Array(calcBuf)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    if (calcHash !== hash) return null;
  } catch {
    return null;
  }

  // auth_date 有效期校验（1 小时）
  const authDate = Number(
    params.get('auth_date') || 0
  );
  if (!authDate) return null;
  if (
    Math.floor(Date.now() / 1000) - authDate >
    3600
  ) {
    return null;
  }

  const userStr = params.get('user');
  if (!userStr) return null;

  try {
    return JSON.parse(userStr);
  } catch {
    return null;
  }
}

// 修复：综合验证提交——身份绑定 + 问答二因素 + Turnstile + 指纹 + 黑名单联动
async function handleVerifySubmit(
  sessionId,
  request,
  env
) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      { ok: false, error: '请求格式错误' },
      400
    );
  }

  const session = await dbGetVerifySession(
    env,
    sessionId
  );
  if (!session) {
    return jsonResponse(
      { ok: false, error: '验证链接无效' },
      404
    );
  }

  const now = Math.floor(Date.now() / 1000);
  if (
    session.status !== 'pending' ||
    now > session.expires_at
  ) {
    return jsonResponse(
      {
        ok: false,
        error: '验证链接已失效，请在 Telegram 中重新发起验证'
      },
      410
    );
  }

  // 0. 黑名单预检：已拉黑用户直接拒绝
  if (
    await dbIsBlacklisted(env, session.user_id)
  ) {
    await dbUpdateVerifySession(
      env,
      sessionId,
      'failed',
      null
    );
    return jsonResponse(
      { ok: false, error: '该账号已被加入黑名单' },
      403
    );
  }

  // 1. WebApp initData 身份绑定校验
  const tgUser = await validateWebAppData(
    body.initData || '',
    env.BOT_TOKEN
  );
  if (
    !tgUser ||
    String(tgUser.id) !== String(session.user_id)
  ) {
    return jsonResponse(
      {
        ok: false,
        error: '身份校验失败，请从 Telegram 内重新打开验证'
      },
      403
    );
  }

  // 2. 问答验证（第二因素，仅在配置了验证问题时启用）
  const verifQ = await getConfig('verif_q', env);
  if (verifQ && verifQ.trim()) {
    const expected = await getConfig(
      'verif_a',
      env,
      '3'
    );
    const expectedAnswers = expected
      .split('|')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const userAnswer = String(
      body.answer || ''
    )
      .trim()
      .toLowerCase();

    if (!expectedAnswers.includes(userAnswer)) {
      return jsonResponse(
        { ok: false, error: '验证答案不正确，请重试' },
        403
      );
    }
  }

  // 3. 校验 Turnstile token
  const turnstileOk = await verifyTurnstile(
    body.token,
    env
  );
  if (!turnstileOk) {
    await dbUpdateVerifySession(
      env,
      sessionId,
      'failed',
      null
    );
    return jsonResponse(
      { ok: false, error: '人机验证失败，请重试' },
      403
    );
  }

  // 4. 解析指纹数据（后台静默采集，用户无感知）
  const fp = body.fingerprint || {};
  const deviceSignals = {
    canvas: fp.canvas || '',
    webgl: fp.webgl || '',
    audio: fp.audio || '',
    os: fp.os || '',
    cpu: fp.cpu || '',
    screen: fp.screen || '',
    fonts: fp.fonts || ''
  };
  const deviceHash = normalizeDeviceHash(
    deviceSignals
  );
  const deviceJson = JSON.stringify(
    deviceSignals
  );

  // 公网 IP 从 Cloudflare 请求头获取
  const pubIp =
    request.headers.get('cf-connecting-ip') ||
    request.headers
      .get('x-forwarded-for')
      ?.split(',')[0]
      ?.trim() ||
    null;

  // ASN/ISP 从 Cloudflare request.cf 对象获取
  const cf = request.cf || {};
  const pubAsn = cf.asn
    ? String(cf.asn)
    : null;
  const pubIsp =
    cf.asOrganization || null;

  const webrtcIp = fp.webrtc_ip || null;
  // 修复：WebRTC IP 与公网 IP 一致时复用公网 ASN/ISP，避免恒为 null
  const webrtcAsn =
    webrtcIp && pubIp && webrtcIp === pubIp
      ? pubAsn
      : null;
  const webrtcIsp =
    webrtcIp && pubIp && webrtcIp === pubIp
      ? pubIsp
      : null;

  // 4.5 IP 封禁检查：公网 IP 或 WebRTC IP 命中封禁列表 → 验证完直接封禁
  let blockedByIp = false;
  let bannedIpHit = null;
  try {
    if (pubIp && await dbIsIpBanned(env, pubIp)) {
      blockedByIp = true;
      bannedIpHit = pubIp;
    } else if (webrtcIp && webrtcIp !== pubIp && await dbIsIpBanned(env, webrtcIp)) {
      blockedByIp = true;
      bannedIpHit = webrtcIp;
    }
  } catch (e) {
    console.error('IP 封禁检查失败：', e?.message || e);
  }

  if (blockedByIp) {
    await dbUpdateVerifySession(
      env,
      sessionId,
      'failed',
      null
    );

    await dbUserUpdate(
      session.user_id,
      {
        is_blocked: true,
        user_state: USER_STATE.NEW
      },
      env
    );

    try {
      await dbBlacklistAdd(
        env,
        session.user_id,
        `IP 命中封禁列表 (${bannedIpHit})`,
        'ip_ban'
      );
    } catch (e) {
      console.error('写入黑名单失败：', e?.message || e);
    }

    try {
      await telegramApi(
        env.BOT_TOKEN,
        'sendMessage',
        {
          chat_id: session.user_id,
          text:
            '❌ 验证未通过，系统检测到异常，请联系管理员。'
        }
      );
    } catch (e) {
      console.error('通知用户拦截失败：', e?.message || e);
    }

    return jsonResponse(
      { ok: false, error: '验证未通过' },
      403
    );
  }

  // 5. 写入指纹
  const fpId = await dbInsertFingerprint(env, {
    user_id: session.user_id,
    session_id: sessionId,
    pub_ip: pubIp,
    pub_asn: pubAsn,
    pub_isp: pubIsp,
    webrtc_ip: webrtcIp,
    webrtc_asn: webrtcAsn,
    webrtc_isp: webrtcIsp,
    device_json: deviceJson,
    device_hash: deviceHash
  });

  // 6. 黑名单联动：相似指纹命中"封禁类"标签则拒绝验证并封禁
  const insertedFp = await dbGetFingerprintById(
    env,
    fpId
  );
  let blockedByFingerprint = false;

  if (insertedFp) {
    try {
      const similar =
        await findSimilarFingerprints(
          env.TG_BOT_DB,
          insertedFp
        );
      const blockPattern =
        /block|ban|黑名单|封禁/i;

      for (const h of similar) {
        const hasBlockTag = h.tags.some((t) =>
          blockPattern.test(t.tag)
        );
        if (hasBlockTag) {
          blockedByFingerprint = true;
          break;
        }
      }
    } catch (e) {
      console.error(
        '指纹相似度匹配失败：',
        e?.message || e
      );
    }
  }

  if (blockedByFingerprint) {
    await dbUpdateVerifySession(
      env,
      sessionId,
      'failed',
      fpId
    );

    await dbUserUpdate(
      session.user_id,
      {
        is_blocked: true,
        user_state: USER_STATE.NEW
      },
      env
    );

    try {
      await dbBlacklistAdd(
        env,
        session.user_id,
        '相似指纹命中封禁标签',
        'fingerprint'
      );
    } catch (e) {
      console.error(
        '写入黑名单失败：',
        e?.message || e
      );
    }

    try {
      await telegramApi(
        env.BOT_TOKEN,
        'sendMessage',
        {
          chat_id: session.user_id,
          text:
            '❌ 验证未通过，' +
            '系统检测到异常，请联系管理员。'
        }
      );
    } catch (e) {
      console.error(
        '通知用户拦截失败：',
        e?.message || e
      );
    }

    return jsonResponse(
      { ok: false, error: '验证未通过' },
      403
    );
  }

  // 7. 更新会话状态
  await dbUpdateVerifySession(
    env,
    sessionId,
    'success',
    fpId
  );

  // 8. 标记用户已验证
  await dbUserUpdate(
    session.user_id,
    { user_state: USER_STATE.VERIFIED },
    env
  );

  // 8.1 清除测试验证模式标记（如有）
  await setConfig(
    `test_verify_${session.user_id}`,
    '',
    env
  );

  // 9. 通知用户验证成功（失败不阻塞响应）
  try {
    await telegramApi(
      env.BOT_TOKEN,
      'sendMessage',
      {
        chat_id: session.user_id,
        text:
          '🎉 验证成功！现在可以开始发送消息了。'
      }
    );
  } catch (e) {
    console.error(
      '通知用户验证成功失败：',
      e?.message || e
    );
  }

  return jsonResponse({ ok: true });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type':
        'application/json; charset=utf-8'
    }
  });
}

/* -------------------------------------------------------------------------- */
/*                         Cloudflare Worker 入口                               */
/* -------------------------------------------------------------------------- */

export default {
  async fetch(request, env, ctx) {
    try {
      validateEnvironment(env);
      await ensureMigration(env);

      ctx.waitUntil(
        ensureBotCommands(env)
      );
    } catch (error) {
      console.error(
        '初始化失败：',
        error?.message || error
      );

      return new Response(
        `Initialization Error: ` +
        `${error?.message || error}`,
        {
          status: 500,
          headers: {
            'content-type':
              'text/plain; charset=utf-8'
          }
        }
      );
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // ---------- 验证页 ----------
    const verifyMatch = path.match(
      /^\/verify\/([a-f0-9-]{36})$/i
    );
    if (verifyMatch && method === 'GET') {
      const session = await dbGetVerifySession(
        env,
        verifyMatch[1]
      );
      if (!session) {
        return new Response(
          '验证链接无效或已过期。',
          {
            status: 404,
            headers: {
              'Content-Type':
                'text/html; charset=utf-8'
            }
          }
        );
      }
      const now = Math.floor(
        Date.now() / 1000
      );
      if (
        session.status !== 'pending' ||
        now > session.expires_at
      ) {
        return new Response(
          '该验证链接已失效，请在 Telegram 中重新发起验证。',
          {
            status: 410,
            headers: {
              'Content-Type':
                'text/html; charset=utf-8'
            }
          }
        );
      }
      const verifQ = await getConfig(
        'verif_q',
        env
      );
      const html = renderVerifyPage(
        verifyMatch[1],
        env.TURNSTILE_SITE_KEY,
        env.BOT_USERNAME || '',
        verifQ
      );
      return new Response(html, {
        headers: {
          'Content-Type':
            'text/html; charset=utf-8'
        }
      });
    }

    // ---------- 提交验证 ----------
    const apiVerifyMatch = path.match(
      /^\/api\/verify\/([a-f0-9-]{36})$/i
    );
    if (apiVerifyMatch && method === 'POST') {
      return handleVerifySubmit(
        apiVerifyMatch[1],
        request,
        env
      );
    }

    if (request.method === 'GET') {
      return new Response(
        'Telegram Bot Worker is running.',
        {
          status: 200,
          headers: {
            'content-type':
              'text/plain; charset=utf-8'
          }
        }
      );
    }

    if (request.method !== 'POST') {
      return new Response(
        'Method Not Allowed',
        {
          status: 405,
          headers: {
            Allow: 'GET, POST'
          }
        }
      );
    }

    const webhookSecret = request.headers.get(
      'X-Telegram-Bot-Api-Secret-Token'
    );

    if (
      !webhookSecret ||
      webhookSecret !== env.WEBHOOK_SECRET
    ) {
      console.warn(
        '收到未通过 Webhook Secret 验证的请求。'
      );

      return new Response(
        'Unauthorized',
        {
          status: 401
        }
      );
    }

    let update;

    try {
      update = await request.json();
    } catch (error) {
      console.error(
        '解析 Telegram Update 失败：',
        error?.message || error
      );

      return new Response(
        'Bad Request',
        {
          status: 400
        }
      );
    }

    ctx.waitUntil(
      handleUpdate(update, env).catch(
        (error) => {
          console.error(
            '异步处理 Update 失败：',
            error?.stack ||
            error?.message ||
            error
          );
        }
      )
    );

    if (Math.random() < 0.01) {
      ctx.waitUntil(
        cleanupDatabase(env)
      );
    }

    return new Response('OK', {
      status: 200,
      headers: {
        'content-type':
          'text/plain; charset=utf-8'
      }
    });
  }
};
