import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "..", "user-config.json");

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

// Mapping angka untuk kemudahan setting via HP
const COMMAND_MAP = {
  "1": "minSolToOpen",
  "2": "deployAmountSol",
  "3": "gasReserve"
};

// ─── CONFIG HELPERS ───────────────────────────────────────────────

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

// ─── AUTHORIZATION ────────────────────────────────────────────────

function isAuthorizedIncomingMessage(msg) {
  const incomingChatId = String(msg.chat?.id || "");
  const senderUserId = msg.from?.id != null ? String(msg.from.id) : null;
  if (!chatId || incomingChatId !== chatId) return false;
  if (ALLOWED_USER_IDS.size > 0 && (!senderUserId || !ALLOWED_USER_IDS.has(senderUserId))) return false;
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

async function postTelegramRaw(method, body) {
  if (!TOKEN) return null;
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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

export async function editMessage(text, messageId) { 
  return postTelegram("editMessageText", { message_id: messageId, text: String(text).slice(0, 4096) }); 
}

export async function answerCallbackQuery(callbackQueryId, text = "") {
  if (!TOKEN || !callbackQueryId) return null;
  return postTelegramRaw("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text: String(text).slice(0, 200) } : {}),
  });
}

// ─── LIVE MESSAGE & NOTIFICATIONS ─────────────────────────────────

export function hasActiveLiveMessage() { return _liveMessageDepth > 0; }

export async function createLiveMessage(title, intro = "Starting...") {
  if (!TOKEN || !chatId) return null;
  _liveMessageDepth += 1;
  const state = { title, intro, toolLines: [], footer: "", messageId: null };
  const flush = async () => {
    const text = `${state.title}\n\n${state.intro}\n\n${state.toolLines.join("\n")}\n\n${state.footer}`;
    if (!state.messageId) {
      const sent = await sendMessage(text);
      state.messageId = sent?.result?.message_id;
    } else {
      await editMessage(text, state.messageId);
    }
  };
  await flush();
  return {
    toolStart: async (n) => { state.toolLines.push(`ℹ️ ${n}...`); await flush(); },
    toolFinish: async (n, r, s) => { 
      const idx = state.toolLines.findIndex(l => l.includes(n));
      if (idx >= 0) state.toolLines[idx] = `${s ? "✅" : "❌"} ${n}`;
      await flush(); 
    },
    finalize: async (t) => { state.footer = t; await flush(); _liveMessageDepth = Math.max(0, _liveMessageDepth - 1); },
    fail: async (e) => { state.footer = `❌ ${e}`; await flush(); _liveMessageDepth = Math.max(0, _liveMessageDepth - 1); }
  };
}

export async function notifyDeploy({ pair, amountSol }) { 
  if (!hasActiveLiveMessage()) await sendHTML(`✅ <b>Deployed</b> ${pair}\nAmount: ${amountSol} SOL`); 
}

export async function notifyClose({ pair, pnlUsd }) { 
  if (!hasActiveLiveMessage()) await sendHTML(`🔒 <b>Closed</b> ${pair}\nPnL: $${(pnlUsd || 0).toFixed(2)}`); 
}

export async function notifySwap({ inputSymbol, outputSymbol }) { 
  if (!hasActiveLiveMessage()) await sendHTML(`🔄 <b>Swapped</b> ${inputSymbol} → ${outputSymbol}`); 
}

export async function notifyOutOfRange({ pair, minutesOOR }) { 
  if (!hasActiveLiveMessage()) await sendHTML(`⚠️ <b>OOR</b> ${pair} (${minutesOOR}m)`); 
}

// ─── POLLING & COMMAND HANDLER ────────────────────────────────────

async function poll(onMessage) {
  while (_polling) {
    try {
      const res = await fetch(`${BASE}/getUpdates?offset=${_offset}&timeout=30`);
      if (!res.ok) throw new Error("Fetch failed");
      const data = await res.json();
      for (const update of data.result || []) {
        _offset = update.update_id + 1;
        const msg = update.message || (update.callback_query ? update.callback_query.message : null);
        if (!msg?.text || !isAuthorizedIncomingMessage(msg)) continue;

        const text = msg.text.trim();

        if (text === "/plan" || text === "/start") {
          await sendHTML(`
📊 <b>Quick Config Menu</b>
Gunakan: <code>/set [nomor] [nilai]</code>

1️⃣ <b>minSolToOpen</b> (Saldo min)
2️⃣ <b>deployAmountSol</b> (Nominal trade)
3️⃣ <b>gasReserve</b> (Cadangan gas)

💡 <b>Contoh:</b>
<code>/set 1 0.1</code>
          `);
          continue;
        }

        if (text.startsWith("/set ")) {
          const parts = text.split(" ");
          let key = parts[1];
          const val = parts[2];
          if (!key || !val) {
            await sendMessage("❌ Format: /set [nomor] [nilai]");
            continue;
          }
          if (COMMAND_MAP[key]) key = COMMAND_MAP[key];
          const res = await updateConfig(key, val);
          if (res.success) await sendHTML(`✅ <b>${key}</b> diubah ke <b>${res.val}</b>`);
          else await sendMessage(`❌ Gagal: ${res.msg}`);
          continue;
        }

        await onMessage(msg);
      }
    } catch (e) { await new Promise(r => setTimeout(r, 5000)); }
  }
}

export function startPolling(onMessage) { 
  if (TOKEN) { _polling = true; poll(onMessage); log("telegram", "Polling started"); } 
}

export function stopPolling() { _polling = false; }