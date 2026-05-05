import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const BASE = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;
const ALLOWED_USER_IDS = new Set(
  String(process.env.TELEGRAM_ALLOWED_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

let chatId = process.env.TELEGRAM_CHAT_ID || null;
let _offset = 0;
let _polling = false;
let _liveMessageDepth = 0;
let _warnedMissingChatId = false;
let _warnedMissingAllowedUsers = false;

// ─── CONFIG & CHAT ID PERSISTENCE ──────────────────────────────────

function loadChatId() {
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      if (cfg.telegramChatId) chatId = cfg.telegramChatId;
    }
  } catch (error) {
    log("telegram_warn", `Invalid user-config.json; chatId not loaded: ${error.message}`);
  }
}

function saveChatId(id) {
  try {
    let cfg = fs.existsSync(USER_CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
      : {};
    cfg.telegramChatId = id;
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {
    log("telegram_error", `Failed to persist chatId: ${e.message}`);
  }
}

// Fitur Remote Update Config
async function updateConfig(key, value) {
  try {
    if (!fs.existsSync(USER_CONFIG_PATH)) return { success: false, msg: "File config tidak ditemukan." };
    let cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    let parsedValue = value;
    if (value.toLowerCase() === "true") parsedValue = true;
    else if (value.toLowerCase() === "false") parsedValue = false;
    else if (!isNaN(value) && value.trim() !== "") parsedValue = parseFloat(value);

    cfg[key] = parsedValue;
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
    return { success: true, val: parsedValue };
  } catch (e) {
    return { success: false, msg: e.message };
  }
}

loadChatId();

// ─── AUTHORIZATION ────────────────────────────────────────────────

function isAuthorizedIncomingMessage(msg) {
  const incomingChatId = String(msg.chat?.id || "");
  const senderUserId = msg.from?.id != null ? String(msg.from.id) : null;
  const chatType = msg.chat?.type || "unknown";

  if (!chatId) {
    if (!_warnedMissingChatId) {
      log("telegram_warn", "Ignoring inbound Telegram messages because TELEGRAM_CHAT_ID is not configured.");
      _warnedMissingChatId = true;
    }
    return false;
  }

  if (incomingChatId !== chatId) return false;

  if (chatType !== "private" && ALLOWED_USER_IDS.size === 0) {
    if (!_warnedMissingAllowedUsers) {
      log("telegram_warn", "Ignoring group messages: TELEGRAM_ALLOWED_USER_IDS not set.");
      _warnedMissingAllowedUsers = true;
    }
    return false;
  }

  if (ALLOWED_USER_IDS.size > 0) {
    if (!senderUserId || !ALLOWED_USER_IDS.has(senderUserId)) return false;
  }

  return true;
}

// ─── CORE SEND FUNCTIONS ──────────────────────────────────────────

export function isEnabled() { return !!TOKEN; }

async function postTelegram(method, body) {
  if (!TOKEN || !chatId) return null;
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, ...body }),
    });
    return res.ok ? await res.json() : null;
  } catch (e) { return null; }
}

export async function sendMessage(text) {
  return postTelegram("sendMessage", { text: String(text).slice(0, 4096) });
}

export async function sendHTML(html) {
  return postTelegram("sendMessage", { text: html.slice(0, 4096), parse_mode: "HTML" });
}

<<<<<<< HEAD
export async function editMessage(text, messageId) {
  if (!TOKEN || !chatId || !messageId) return null;
  return postTelegram("editMessageText", {
    message_id: messageId,
    text: String(text).slice(0, 4096),
  });
}
=======
// ─── POLLING & COMMAND HANDLER ────────────────────────────────────
>>>>>>> ba918f74465c00c1b7753d64a0e637d09c127541

async function poll(onMessage) {
  while (_polling) {
    try {
      const res = await fetch(`${BASE}/getUpdates?offset=${_offset}&timeout=30`, {
        signal: AbortSignal.timeout(35_000)
      });
      if (!res.ok) { await sleep(5000); continue; }
      const data = await res.json();
      for (const update of data.result || []) {
        _offset = update.update_id + 1;
        const msg = update.message || (update.callback_query ? update.callback_query.message : null);
        if (!msg?.text || !isAuthorizedIncomingMessage(msg)) continue;

        const text = msg.text.trim();

        // 1. Command /plan
        if (text === "/plan") {
          const planText = `
📌 **Panduan Nabung (Estimasi Kurs 2.5jt/SOL)**

💰 **Deposit -> Perintah Set:**
• 200rb  : \`/set minSolToOpen 0.08\`
• 400rb  : \`/set minSolToOpen 0.16\`
• 600rb  : \`/set minSolToOpen 0.24\`
• 800rb  : \`/set minSolToOpen 0.32\`
• 1jt    : \`/set minSolToOpen 0.40\`

💡 *Klik perintah di atas untuk copy.*
          `;
          await sendMessage(planText);
          continue;
        }

        // 2. Command /set
        if (text.startsWith("/set ")) {
          const parts = text.split(" ");
          const key = parts[1];
          const val = parts[2];
          if (!key || !val) {
            await sendMessage("❌ Gunakan: `/set [key] [value]`");
          } else {
            const result = await updateConfig(key, val);
            if (result.success) await sendMessage(`✅ **${key}** diubah ke **${result.val}**`);
            else await sendMessage(`❌ Gagal: ${result.msg}`);
          }
          continue;
        }

        // Lanjut ke logika utama bot
        await onMessage(msg);
      }
    } catch (e) {
      await sleep(5000);
    }
  }
}

// ─── EXPORTS (Keep existing notify/polling functions) ─────────────

export function startPolling(onMessage) {
  if (!TOKEN) return;
  _polling = true;
  poll(onMessage);
  log("telegram", "Bot polling started");
}

export function stopPolling() { _polling = false; }

// ... (Tetap sertakan notifyDeploy, notifyClose, notifySwap, dsb dari kode asli Anda di sini)

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
