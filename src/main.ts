import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Script } from "node:vm";
import makeWASocket, { DisconnectReason, downloadContentFromMessage, useMultiFileAuthState, type WASocket } from "@whiskeysockets/baileys";
import pino from "pino";

type LogLevel = "resumidos" | "avancados" | "codigo";
type LogEntry = { id: string; level: LogLevel; time: string; title: string; detail: string; args: string; payload?: unknown };
type CommandRule = { id: string; name: string; aliases: string[]; description: string; enabled: boolean; groupOnly: boolean; code: string; updatedAt: string };

const port = Number(process.env.FLOWBOT_PORT ?? 3000);
const host = process.env.FLOWBOT_HOST ?? "0.0.0.0";
const authDir = resolve(process.env.FLOWBOT_AUTH_DIR ?? "./data/auth");
const codeFile = resolve(process.env.FLOWBOT_CODE_FILE ?? "./data/custom-action.js");
const commandsFile = resolve(process.env.FLOWBOT_COMMANDS_FILE ?? "./data/commands.json");
const botStateFile = resolve(process.env.FLOWBOT_BOT_STATE_FILE ?? "./data/bot-state.json");
const pairingPhone = process.env.PAIRING_PHONE?.replace(/\D/g, "");
const commandPrefix = process.env.FLOWBOT_COMMAND_PREFIX ?? "#";
const logger = pino({ level: "silent" });
const logs: LogEntry[] = [];
let socket: WASocket | null = null;
let connection = "disconnected";
let pairingCode: string | null = null;
let customCode = existsSync(codeFile) ? readFileSync(codeFile, "utf8") : "";
let pairingTimer: ReturnType<typeof setTimeout> | null = null;
let pairingInFlight = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let botEnabled = readJsonFile<{ enabled?: boolean }>(botStateFile)?.enabled !== false;
let commandRules: CommandRule[] = readJsonFile<CommandRule[]>(commandsFile) ?? [];

function readJsonFile<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { return null; }
}

function writeJsonFile(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function normalizeCommand(value: string): string {
  return value.trim().toLowerCase().replace(/^[#!/.]+/, "").split(/\s+/)[0] ?? "";
}

function parseCommand(text: string | null): { name: string | null; args: string; raw: string } {
  const raw = text?.trim() ?? "";
  const prefix = raw.startsWith(commandPrefix) || /^[#!/.]/.test(raw);
  if (!prefix) return { name: null, args: "", raw };
  const [first = "", ...rest] = raw.split(/\s+/);
  return { name: normalizeCommand(first), args: rest.join(" "), raw };
}

function addLog(level: LogLevel, title: string, detail: string, args = "", payload?: unknown): void {
  const entry = { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, level, time: new Date().toISOString(), title, detail, args, payload };
  logs.push(entry);
  if (logs.length > 500) logs.shift();
  if (level !== "codigo") console.log(`[${level}] ${title} | ${detail} | ${args}`);
}

function messageType(message: Record<string, any> | null): { mimetype: string; command: string | null } {
  if (!message) return { mimetype: "error", command: null };
  if (typeof message.conversation === "string") return { mimetype: "text", command: message.conversation };
  if (message.extendedTextMessage) return { mimetype: "text", command: message.extendedTextMessage.text ?? null };
  if (message.imageMessage) return { mimetype: "image", command: message.imageMessage.caption ?? null };
  if (message.videoMessage) return { mimetype: "video", command: message.videoMessage.caption ?? null };
  if (message.audioMessage) return { mimetype: "audio", command: null };
  if (message.stickerMessage) return { mimetype: "sticker", command: null };
  if (message.reactionMessage) return { mimetype: "reaction", command: message.reactionMessage.text ?? null };
  if (message.ephemeralMessage?.message) return messageType(message.ephemeralMessage.message);
  return { mimetype: Object.keys(message)[0] ?? "unknown", command: null };
}

async function normalizarEnviado(message: any): Promise<any> {
  const key = message.key ?? {};
  const raw = message.message ?? {};
  const from = key.remoteJid ?? "";
  const isGroup = from.endsWith("@g.us");
  const metadata = isGroup && socket ? await socket.groupMetadata(from).catch(() => null) : null;
  const contextInfo = raw.extendedTextMessage?.contextInfo ?? raw.imageMessage?.contextInfo ?? raw.videoMessage?.contextInfo ?? {};
  const mimetyped = messageType(raw);
  const commandData = parseCommand(mimetyped.command);
  const sender = key.participant ?? from;
  const numeroUsuario = String(sender).split("@")[0]?.split(":")[0] ?? "";
  return {
    key,
    message: raw,
    isGroup,
    sender,
    nomeUsuario: message.pushName ?? null,
    numeroUsuario,
    idMensagem: key.id ?? null,
    from,
    chat: from,
    fromMe: Boolean(key.fromMe),
    mimetyped,
    texto: commandData.raw,
    comando: commandData.name,
    argumentos: commandData.args,
    quotedMessage: contextInfo.quotedMessage ?? null,
    quotedMessageSender: contextInfo.participant ?? null,
    mentionedJidList: contextInfo.mentionedJid ?? [],
    metadata,
    mensagem: raw,
  };
}

async function atualizarPresenca(client: WASocket, idChat: string, tipo: string): Promise<void> {
  await client.presenceSubscribe(idChat);
  await client.sendPresenceUpdate(tipo as any, idChat);
  await client.sendPresenceUpdate("paused", idChat);
}

async function enviarTexto(client: WASocket, idChat: string, texto: string): Promise<unknown> {
  await atualizarPresenca(client, idChat, "composing");
  return client.sendMessage(idChat, { text: texto, linkPreview: null });
}

async function responderTexto(client: WASocket, idChat: string, texto: string, mensagemCitada?: any): Promise<unknown> {
  await atualizarPresenca(client, idChat, "composing");
  return client.sendMessage(idChat, { text: texto, linkPreview: null }, mensagemCitada?.key ? { quoted: mensagemCitada } : undefined);
}

async function reagir(client: WASocket, idChat: string, mensagem: any, emoji: string): Promise<unknown> {
  return client.sendMessage(idChat, { react: { text: emoji, key: mensagem?.key ?? mensagem } });
}

async function enviarFigurinha(client: WASocket, idChat: string, sticker: unknown): Promise<unknown> {
  return client.sendMessage(idChat, { sticker: sticker as any });
}

async function deletarMensagem(client: WASocket, enviado: any, mensagemCitada = false): Promise<unknown> {
  const key = mensagemCitada ? { remoteJid: enviado.key.remoteJid, fromMe: false, id: enviado.key.id, participant: enviado.quotedMessageSender } : enviado.key;
  return client.sendMessage(enviado.chat, { delete: key });
}

async function enviarEnquete(client: WASocket, idChat: string, nome: string, opcoes: string[]): Promise<unknown> {
  return client.sendMessage(idChat, { poll: { name: nome, values: opcoes, selectableCount: 1 } });
}

async function atualizarGrupo(client: WASocket, idGrupo: string, participante: string, action: "add" | "remove" | "promote" | "demote"): Promise<unknown> {
  const result = await client.groupParticipantsUpdate(idGrupo, [participante], action);
  return result[0];
}

async function adicionarParticipante(client: WASocket, idGrupo: string, participante: string): Promise<unknown> { return atualizarGrupo(client, idGrupo, participante, "add"); }
async function removerParticipante(client: WASocket, idGrupo: string, participante: string): Promise<unknown> { return atualizarGrupo(client, idGrupo, participante, "remove"); }
async function promoverParticipante(client: WASocket, idGrupo: string, participante: string): Promise<unknown> { return atualizarGrupo(client, idGrupo, participante, "promote"); }
async function rebaixarParticipante(client: WASocket, idGrupo: string, participante: string): Promise<unknown> { return atualizarGrupo(client, idGrupo, participante, "demote"); }

async function baixarMidia(client: WASocket, mensagem: any): Promise<Buffer> {
  const node = mensagem?.imageMessage ?? mensagem?.videoMessage ?? mensagem?.audioMessage ?? mensagem?.viewOnceMessageV2?.message?.imageMessage;
  if (!node) throw new Error("A mensagem não contém mídia baixável.");
  const kind = node.mimetype?.startsWith("video") ? "video" : node.mimetype?.startsWith("audio") ? "audio" : "image";
  const stream = await downloadContentFromMessage(node, kind as any);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function helpers(client: WASocket, enviado: any): Record<string, unknown> {
  return {
    client,
    enviado,
    enviarTexto: (c: WASocket, id: string, texto: string) => enviarTexto(c, id, texto),
    responderTexto: (c: WASocket, id: string, texto: string, citado?: any) => responderTexto(c, id, texto, citado),
    reagir: (c: WASocket, id: string, mensagem: any, emoji: string) => reagir(c, id, mensagem, emoji),
    enviarFigurinha: (c: WASocket, id: string, sticker: unknown) => enviarFigurinha(c, id, sticker),
    deletarMensagem: (c: WASocket, enviadoAtual: any, citada?: boolean) => deletarMensagem(c, enviadoAtual, citada),
    enviarEnquete: (c: WASocket, id: string, nome: string, opcoes: string[]) => enviarEnquete(c, id, nome, opcoes),
    adicionarParticipante: (c: WASocket, id: string, participante: string) => adicionarParticipante(c, id, participante),
    removerParticipante: (c: WASocket, id: string, participante: string) => removerParticipante(c, id, participante),
    promoverParticipante: (c: WASocket, id: string, participante: string) => promoverParticipante(c, id, participante),
    rebaixarParticipante: (c: WASocket, id: string, participante: string) => rebaixarParticipante(c, id, participante),
    baixarMidia: (c: WASocket, mensagem: any) => baixarMidia(c, mensagem),
  };
}

async function executarFonte(code: string, enviado: any, fileName: string, context: Record<string, unknown> = {}): Promise<void> {
  if (!socket || !code.trim()) return;
  const output = (method: string, values: unknown[]) => addLog("codigo", fileName, method, values.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" "));
  const sandbox = { ...helpers(socket, enviado), ...context, console: { log: (...values: unknown[]) => output("console.log", values), info: (...values: unknown[]) => output("console.info", values), warn: (...values: unknown[]) => output("console.warn", values), error: (...values: unknown[]) => output("console.error", values) }, Buffer, JSON, setTimeout, clearTimeout };
  const source = code.replace(/export\s+default\s+async\s+function\s+execute/, "async function execute").replace(/export\s+default\s+function\s+execute/, "function execute");
  const script = new Script(`(async () => { ${source}\n if (typeof execute !== "function") throw new Error("O código precisa exportar execute(client, enviado)"); return execute(client, enviado); })()`);
  try {
    await Promise.race([script.runInNewContext(sandbox), new Promise((_, reject) => setTimeout(() => reject(new Error("Tempo limite do código excedido.")), 8000))]);
  } catch (error) {
    output("console.error", [error instanceof Error ? error.message : String(error)]);
  }
}

async function executarComandos(enviado: any): Promise<void> {
  const command = normalizeCommand(enviado.comando ?? "");
  if (!command) return;
  const matching = commandRules.filter((rule) => rule.enabled && !rule.groupOnly || rule.enabled && rule.groupOnly && enviado.isGroup)
    .filter((rule) => [rule.name, ...rule.aliases].some((alias) => normalizeCommand(alias) === command));
  for (const rule of matching) {
    await executarFonte(rule.code, enviado, `command:${rule.name}.js`, { comando: command, argumentos: enviado.argumentos, regra: rule });
  }
}

async function executarCodigo(enviado: any): Promise<void> {
  if (!botEnabled) return;
  await executarComandos(enviado);
  await executarFonte(customCode, enviado, "custom-action.js");
}

async function conectar(phoneNumber = pairingPhone): Promise<void> {
  if (socket && connection !== "disconnected") return;
  mkdirSync(authDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const client = makeWASocket({ auth: state, printQRInTerminal: false, logger, generateHighQualityLinkPreview: false });
  socket = client;
  connection = "connecting";
  pairingCode = null;
  pairingInFlight = false;
  client.ev.on("creds.update", saveCreds);
  client.ev.on("connection.update", async ({ connection: next, lastDisconnect }) => {
    connection = next ?? connection;
    addLog("avancados", "connection.update", `status=${connection}`, lastDisconnect ? String(lastDisconnect.error ?? "disconnect") : "");
    if (connection === "open") {
      if (pairingTimer) clearTimeout(pairingTimer);
      pairingTimer = null;
      pairingCode = null;
      addLog("resumidos", "Sessão conectada", "Baileys pronto para receber mensagens", "");
    }
    if (connection === "close") {
      if (pairingTimer) clearTimeout(pairingTimer);
      pairingTimer = null;
      socket = null;
      pairingInFlight = false;
      const shouldReconnect = (lastDisconnect?.error as any)?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect && !reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          conectar(phoneNumber).catch((error) => addLog("avancados", "reconnect.error", String(error)));
        }, 2000);
      }
    }
  });
  if (!state.creds.registered && phoneNumber) {
    pairingTimer = setTimeout(async () => {
      pairingTimer = null;
      if (socket !== client || state.creds.registered || pairingInFlight || connection === "close") return;
      pairingInFlight = true;
      try {
        pairingCode = await client.requestPairingCode(phoneNumber);
        addLog("resumidos", "Pairing code", "Código gerado uma única vez para esta tentativa", pairingCode);
      } catch (error) {
        addLog("avancados", "pairing.error", error instanceof Error ? error.message : String(error));
      } finally {
        pairingInFlight = false;
      }
    }, 1800);
  }
  client.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const message of messages) {
      const enviado = await normalizarEnviado(message);
      addLog("resumidos", "Mensagem recebida", `FROM_ID: ${enviado.from} · SENDER: ${enviado.sender}`, `ARGUMENTS: ${enviado.mimetyped.command ?? `[${enviado.mimetyped.mimetype}]`}`);
      addLog("avancados", "messages.upsert", `key.id=${enviado.key.id} · fromMe=${enviado.fromMe}`, `mimetype=${enviado.mimetyped.mimetype} · quoted=${Boolean(enviado.quotedMessage)}`, enviado);
      if (botEnabled) await executarCodigo(enviado);
    }
  });
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" });
  res.end(JSON.stringify(payload));
}

async function body(req: IncomingMessage): Promise<any> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  try {
    if (url.pathname === "/api/v1/health") return json(res, 200, { status: "ok", service: "flowbot-termux", version: "0.1.0", timestamp: new Date().toISOString(), database: "connected" });
    if (url.pathname === "/api/v1/server/capabilities") return json(res, 200, { apiVersion: "v1", backendVersion: "termux-0.1.0", security: { localHttp: true, remoteHttpsRequired: false, jwt: false, websocket: false }, features: { sessions: true, flows: true, flowEditor: true, executions: true, customActions: true } });
    if (url.pathname === "/api/v1/session/status") return json(res, 200, { status: connection, pairingCode, hasAuth: existsSync(authDir) });
    if (url.pathname === "/api/v1/session/connect" && req.method === "POST") {
      const input = await body(req);
      const phoneNumber = String(input.phoneNumber ?? pairingPhone ?? "").replace(/\D/g, "") || undefined;
      await conectar(phoneNumber);
      return json(res, 202, { status: connection, pairingCode, hasAuth: existsSync(authDir), pairingRequired: Boolean(phoneNumber) });
    }
    if (url.pathname === "/api/v1/session/disconnect" && req.method === "POST") { if (pairingTimer) clearTimeout(pairingTimer); if (reconnectTimer) clearTimeout(reconnectTimer); pairingTimer = null; reconnectTimer = null; pairingInFlight = false; socket?.end(undefined); socket = null; connection = "disconnected"; return json(res, 200, { status: connection }); }
    if (url.pathname === "/api/v1/logs" && req.method === "GET") { const level = url.searchParams.get("level") as LogLevel | null; const requestedLimit = Number(url.searchParams.get("limit") ?? 100); const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 500)) : 100; return json(res, 200, logs.filter((item) => !level || item.level === level).slice(-limit)); }
    if (url.pathname === "/api/v1/dashboard") return json(res, 200, { server: { status: connection === "open" ? "online" : "offline", version: "termux-0.1.0", uptimeSeconds: Math.floor(process.uptime()) }, sessions: { active: connection === "open" ? 1 : 0, total: 1 }, messages: { received: logs.filter((item) => item.title === "Mensagem recebida").length, sent: 0 }, flows: { active: customCode ? 1 : 0, executionsInProgress: 0 }, failuresRecent: logs.filter((item) => item.title === "console.error").length });
    if (url.pathname === "/api/v1/bot/status" && req.method === "GET") return json(res, 200, { enabled: botEnabled, commands: commandRules.filter((rule) => rule.enabled).length });
    if (url.pathname === "/api/v1/bot/toggle" && req.method === "POST") { const input = await body(req); botEnabled = Boolean(input.enabled); writeJsonFile(botStateFile, { enabled: botEnabled, updatedAt: new Date().toISOString() }); addLog("resumidos", botEnabled ? "Bot ativado" : "Bot pausado", "Estado alterado pelo painel", ""); return json(res, 200, { enabled: botEnabled }); }
    if (url.pathname === "/api/v1/commands" && req.method === "GET") return json(res, 200, commandRules);
    if (url.pathname === "/api/v1/commands" && req.method === "POST") {
      const input = await body(req);
      const name = normalizeCommand(String(input.name ?? ""));
      if (!name || !String(input.code ?? "").trim()) return json(res, 400, { error: { message: "name e code são obrigatórios." } });
      const aliases = (Array.isArray(input.aliases) ? input.aliases : String(input.aliases ?? "").split(/[\s,]+/)).map((value: unknown) => normalizeCommand(String(value))).filter(Boolean);
      const rule: CommandRule = { id: String(input.id ?? name), name, aliases: Array.from(new Set(aliases.filter((alias: string) => alias !== name))), description: String(input.description ?? ""), enabled: input.enabled !== false, groupOnly: input.groupOnly === true, code: String(input.code), updatedAt: new Date().toISOString() };
      commandRules = [...commandRules.filter((item) => item.id !== rule.id), rule];
      writeJsonFile(commandsFile, commandRules);
      addLog("codigo", `command:${rule.name}`, "Comando salvo pelo painel", rule.aliases.join(", "));
      return json(res, 200, rule);
    }
    if (url.pathname.startsWith("/api/v1/commands/") && req.method === "DELETE") {
      const id = decodeURIComponent(url.pathname.slice("/api/v1/commands/".length));
      const before = commandRules.length;
      commandRules = commandRules.filter((item) => item.id !== id);
      if (commandRules.length !== before) writeJsonFile(commandsFile, commandRules);
      return json(res, 200, { deleted: commandRules.length !== before });
    }
    if (url.pathname === "/api/v1/messages/send" && req.method === "POST") { const input = await body(req); if (!socket) return json(res, 409, { error: { message: "Sessão Baileys desconectada." } }); const sent = await enviarTexto(socket, String(input.chatId), String(input.text)); addLog("resumidos", "Mensagem enviada", `CHAT: ${input.chatId}`, String(input.text)); return json(res, 200, { messageId: (sent as any)?.key?.id ?? "sent" }); }
    if (url.pathname === "/api/v1/custom-code" && req.method === "POST") { const input = await body(req); customCode = String(input.code ?? ""); mkdirSync(dirname(codeFile), { recursive: true }); writeFileSync(codeFile, customCode, "utf8"); addLog("codigo", "custom-code", "Código salvo no Termux", `${customCode.split("\n").length} linhas`); return json(res, 200, { saved: true, file: codeFile }); }
    return json(res, 404, { error: { message: "Rota não encontrada." } });
  } catch (error) {
    addLog("avancados", "server.error", error instanceof Error ? error.message : String(error));
    return json(res, 500, { error: { message: error instanceof Error ? error.message : "Erro interno." } });
  }
});

server.listen(port, host, () => {
  console.log(`FlowBot Termux em http://${host}:${port}`);
  if (pairingPhone) conectar(pairingPhone).catch((error) => addLog("avancados", "startup.error", String(error)));
});


