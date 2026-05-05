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
      log("telegram_warn", "Ignoring inbound Telegram messages: TELEGRAM_CHAT_ID not configured.");
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

export async function sendMessageWithButtons(text, inlineKeyboard) {
  return postTelegram("sendMessage", {
    text: String(text).slice(0, 4096),
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

export async function editMessageWithButtons(text, messageId, inlineKeyboard) {
  if (!TOKEN || !chatId || !messageId) return null;
  return postTelegram("editMessageText", {
    message_id: messageId,
    text: String(text).slice(0, 4096),
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

export async function editMessage(text, messageId) {
  if (!TOKEN || !chatId || !messageId) return null;
  return postTelegram("editMessageText", {
    message_id: messageId,
    text: String(text).slice(0, 4096),
  });
}

export async function answerCallbackQuery(callbackQueryId, text = "") {
  if (!TOKEN || !callbackQueryId) return null;
  return postTelegramRaw("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text: String(text).slice(0, 200) } : {}),
  });
}

// ─── LIVE MESSAGE SYSTEM ──────────────────────────────────────────

export function hasActiveLiveMessage() { return _liveMessageDepth > 0; }

function createTypingIndicator() {
  if (!TOKEN || !chatId) return { stop() {} };
  let stopped = false;
  let timer = null;
  async function tick() {
    if (stopped) return;
    await postTelegram("sendChatAction", { action: "typing" });
    timer = setTimeout(() => { tick().catch(() => null); }, 4000);
  }
  tick().catch(() => null);
  return { stop() { stopped = true; if (timer) clearTimeout(timer); } };
}

function toolLabel(name) {
  const labels = {
    deploy_position: "deploy position",
    close_position: "close position",
    claim_fees: "claim fees",
    update_config: "update config",
    get_wallet_balance: "get wallet balance",
  };
  return labels[name] || name.replace(/_/g, " ");
}

function summarizeToolResult(name, result) {
  if (!result) return "";
  if (result.error) return result.error;
  switch (name) {
    case "deploy_position": return result.position ? `pos ${String(result.position).slice(0, 8)}...` : "done";
    case "get_wallet_balance": return `${result.sol ?? "?"} SOL`;
    case "update_config": return "updated";
    default: return result.success === false ? "failed" : "done";
  }
}

export async function createLiveMessage(title, intro = "Starting...") {
  if (!TOKEN || !chatId) return null;
  const typing = createTypingIndicator();
  const state = { title, intro, toolLines: [], footer: "", messageId: null, flushTimer: null, flushPromise: null };

  function render() {
    const sections = [state.title, state.intro];
    if (state.toolLines.length > 0) sections.push(state.toolLines.join("\n"));
    if (state.footer) sections.push(state.footer);
    return sections.join("\n\n").slice(0, 4096);
  }

  async function flushNow() {
    state.flushTimer = null;
    const text = render();
    if (!state.messageId) {
      const sent = await sendMessage(text);
      state.messageId = sent?.result?.message_id ?? null;
    } else {
      await editMessage(text, state.messageId);
    }
  }

  function scheduleFlush() {
    if (state.flushTimer) return;
    state.flushTimer = setTimeout(() => { state.flushPromise = flushNow().catch(() => null); }, 300);
  }

  _liveMessageDepth += 1;
  await flushNow();

  return {
    async toolStart(name) {
      const label = toolLabel(name);
      state.toolLines.push(`ℹ️ ${label}...`);
      scheduleFlush();
    },
    async toolFinish(name, result, success) {
      const label = toolLabel(name);
      const icon = success ? "✅" : "❌";
      const summary = summarizeToolResult(name, result);
      const idx = state.toolLines.findIndex(l => l.includes(label));
      if (idx >= 0) state.toolLines[idx] = `${icon} ${label} ${summary ? `— ${summary}` : ""}`;
      scheduleFlush();
    },
    async finalize(text) {
      if (state.flushTimer) clearTimeout(state.flushTimer);
      state.footer = text;
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
    async fail(err) {
      state.footer = `❌ ${err}`;
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    }
  };
}

// ─── POLLING & COMMAND HANDLER ────────────────────────────────────

async function poll(onMessage) {
  while (_polling) {
    try {
      const res = await fetch(`${BASE}/getUpdates?offset=${_offset}&timeout=30`, { signal: AbortSignal.timeout(35_000) });
      if (!res.ok) { await sleep(5000); continue; }
      const data = await res.json();
      for (const update of data.result || []) {
        _offset = update.update_id + 1;
        
        const msg = update.message || (update.callback_query ? update.callback_query.message : null);
        if (!msg?.text || !isAuthorizedIncomingMessage(msg)) continue;

        const text = msg.text.trim();

        if (text === "/plan") {
          await sendMessage(`
📌 **Panduan Nabung (Estimasi Kurs 2.5jt/SOL)**
• 200rb  : \`/set minSolToOpen 0.08\`
• 400rb  : \`/set minSolToOpen 0.16\`
• 600rb  : \`/set minSolToOpen 0.24\`
• 800rb  : \`/set minSolToOpen 0.32\`
• 1jt    : \`/set minSolToOpen 0.40\`
          `);
          continue;
        }

        if (text.startsWith("/set ")) {
          const [_, key, val] = text.split(" ");
          if (!key || !val) { await sendMessage("❌ Gunakan: /set [key] [val]"); continue; }
          const res = await updateConfig(key, val);
          if (res.success) await sendMessage(`✅ **${key}** diubah ke **${res.val}**`);
          else await sendMessage(`❌ Gagal: ${res.msg}`);
          continue;
        }

        await onMessage(msg);
      }
    } catch (e) { await sleep(5000); }
  }
}

export function startPolling(onMessage) {
  if (!TOKEN) return;
  _polling = true;
  poll(onMessage);
  log("telegram", "Bot polling started");
}

export function stopPolling() { _polling = false; }

// ─── NOTIFICATION HELPERS ─────────────────────────────────────────

export async function notifyDeploy({ pair, amountSol, position, tx, priceRange, rangeCoverage, binStep, baseFee }) {
  if (hasActiveLiveMessage()) return;
  await sendHTML(`✅ <b>Deployed</b> ${pair}\nAmount: ${amountSol} SOL\nPos: <code>${position?.slice(0, 8)}...</code>`);
}

export async function notifyClose({ pair, pnlUsd, pnlPct }) {
  if (hasActiveLiveMessage()) return;
  const sign = pnlUsd >= 0 ? "+" : "";
  await sendHTML(`🔒 <b>Closed</b> ${pair}\nPnL: ${sign}$${(pnlUsd ?? 0).toFixed(2)} (${sign}${(pnlPct ?? 0).toFixed(2)}%)`);
}

export async function notifySwap({ inputSymbol, outputSymbol, amountIn, amountOut, tx }) {
  if (hasActiveLiveMessage()) return;
  await sendHTML(`🔄 <b>Swapped</b> ${inputSymbol} → ${outputSymbol}\nTx: <code>${tx?.slice(0, 16)}...</code>`);
}

export async function notifyOutOfRange({ pair, minutesOOR }) {
  if (hasActiveLiveMessage()) return;
  await sendHTML(`⚠️ <b>Out of Range</b> ${pair}\nOOR for ${minutesOOR} minutes`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function fmtPct(value) { return Number.isFinite(Number(value)) ? `${Number(value).toFixed(2)}%` : "?"; }