import "dotenv/config";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Script } from "node:vm";
import makeWASocket, { DisconnectReason, downloadContentFromMessage, useMultiFileAuthState } from "@whiskeysockets/baileys";
import pino from "pino";
const port = Number(process.env.FLOWBOT_PORT ?? 3000);
const host = process.env.FLOWBOT_HOST ?? "0.0.0.0";
const authDir = resolve(process.env.FLOWBOT_AUTH_DIR ?? "./data/auth");
const codeFile = resolve(process.env.FLOWBOT_CODE_FILE ?? "./data/custom-action.js");
const pairingPhone = process.env.PAIRING_PHONE?.replace(/\D/g, "");
const logger = pino({ level: "silent" });
const logs = [];
let socket = null;
let connection = "disconnected";
let pairingCode = null;
let customCode = existsSync(codeFile) ? readFileSync(codeFile, "utf8") : "";
function addLog(level, title, detail, args = "", payload) {
    const entry = { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, level, time: new Date().toISOString(), title, detail, args, payload };
    logs.push(entry);
    if (logs.length > 500)
        logs.shift();
    if (level !== "codigo")
        console.log(`[${level}] ${title} | ${detail} | ${args}`);
}
function messageType(message) {
    if (!message)
        return { mimetype: "error", command: null };
    if (typeof message.conversation === "string")
        return { mimetype: "text", command: message.conversation };
    if (message.extendedTextMessage)
        return { mimetype: "text", command: message.extendedTextMessage.text ?? null };
    if (message.imageMessage)
        return { mimetype: "image", command: message.imageMessage.caption ?? null };
    if (message.videoMessage)
        return { mimetype: "video", command: message.videoMessage.caption ?? null };
    if (message.audioMessage)
        return { mimetype: "audio", command: null };
    if (message.stickerMessage)
        return { mimetype: "sticker", command: null };
    if (message.reactionMessage)
        return { mimetype: "reaction", command: message.reactionMessage.text ?? null };
    if (message.ephemeralMessage?.message)
        return messageType(message.ephemeralMessage.message);
    return { mimetype: Object.keys(message)[0] ?? "unknown", command: null };
}
async function normalizarEnviado(message) {
    const key = message.key ?? {};
    const raw = message.message ?? {};
    const from = key.remoteJid ?? "";
    const isGroup = from.endsWith("@g.us");
    const metadata = isGroup && socket ? await socket.groupMetadata(from).catch(() => null) : null;
    const contextInfo = raw.extendedTextMessage?.contextInfo ?? raw.imageMessage?.contextInfo ?? raw.videoMessage?.contextInfo ?? {};
    const mimetyped = messageType(raw);
    return {
        key,
        message: raw,
        isGroup,
        sender: key.participant ?? from,
        from,
        chat: from,
        fromMe: Boolean(key.fromMe),
        mimetyped,
        quotedMessage: contextInfo.quotedMessage ?? null,
        quotedMessageSender: contextInfo.participant ?? null,
        mentionedJidList: contextInfo.mentionedJid ?? [],
        metadata,
        mensagem: raw,
    };
}
async function atualizarPresenca(client, idChat, tipo) {
    await client.presenceSubscribe(idChat);
    await client.sendPresenceUpdate(tipo, idChat);
    await client.sendPresenceUpdate("paused", idChat);
}
async function enviarTexto(client, idChat, texto) {
    await atualizarPresenca(client, idChat, "composing");
    return client.sendMessage(idChat, { text: texto, linkPreview: null });
}
async function responderTexto(client, idChat, texto, mensagemCitada) {
    await atualizarPresenca(client, idChat, "composing");
    return client.sendMessage(idChat, { text: texto, linkPreview: null }, mensagemCitada?.key ? { quoted: mensagemCitada } : undefined);
}
async function reagir(client, idChat, mensagem, emoji) {
    return client.sendMessage(idChat, { react: { text: emoji, key: mensagem?.key ?? mensagem } });
}
async function enviarFigurinha(client, idChat, sticker) {
    return client.sendMessage(idChat, { sticker: sticker });
}
async function deletarMensagem(client, enviado, mensagemCitada = false) {
    const key = mensagemCitada ? { remoteJid: enviado.key.remoteJid, fromMe: false, id: enviado.key.id, participant: enviado.quotedMessageSender } : enviado.key;
    return client.sendMessage(enviado.chat, { delete: key });
}
async function enviarEnquete(client, idChat, nome, opcoes) {
    return client.sendMessage(idChat, { poll: { name: nome, values: opcoes, selectableCount: 1 } });
}
async function atualizarGrupo(client, idGrupo, participante, action) {
    const result = await client.groupParticipantsUpdate(idGrupo, [participante], action);
    return result[0];
}
async function adicionarParticipante(client, idGrupo, participante) { return atualizarGrupo(client, idGrupo, participante, "add"); }
async function removerParticipante(client, idGrupo, participante) { return atualizarGrupo(client, idGrupo, participante, "remove"); }
async function promoverParticipante(client, idGrupo, participante) { return atualizarGrupo(client, idGrupo, participante, "promote"); }
async function rebaixarParticipante(client, idGrupo, participante) { return atualizarGrupo(client, idGrupo, participante, "demote"); }
async function baixarMidia(client, mensagem) {
    const node = mensagem?.imageMessage ?? mensagem?.videoMessage ?? mensagem?.audioMessage ?? mensagem?.viewOnceMessageV2?.message?.imageMessage;
    if (!node)
        throw new Error("A mensagem não contém mídia baixável.");
    const kind = node.mimetype?.startsWith("video") ? "video" : node.mimetype?.startsWith("audio") ? "audio" : "image";
    const stream = await downloadContentFromMessage(node, kind);
    const chunks = [];
    for await (const chunk of stream)
        chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
}
function helpers(client, enviado) {
    return {
        client,
        enviado,
        enviarTexto: (c, id, texto) => enviarTexto(c, id, texto),
        responderTexto: (c, id, texto, citado) => responderTexto(c, id, texto, citado),
        reagir: (c, id, mensagem, emoji) => reagir(c, id, mensagem, emoji),
        enviarFigurinha: (c, id, sticker) => enviarFigurinha(c, id, sticker),
        deletarMensagem: (c, enviadoAtual, citada) => deletarMensagem(c, enviadoAtual, citada),
        enviarEnquete: (c, id, nome, opcoes) => enviarEnquete(c, id, nome, opcoes),
        adicionarParticipante: (c, id, participante) => adicionarParticipante(c, id, participante),
        removerParticipante: (c, id, participante) => removerParticipante(c, id, participante),
        promoverParticipante: (c, id, participante) => promoverParticipante(c, id, participante),
        rebaixarParticipante: (c, id, participante) => rebaixarParticipante(c, id, participante),
        baixarMidia: (c, mensagem) => baixarMidia(c, mensagem),
    };
}
async function executarCodigo(enviado) {
    if (!socket || !customCode.trim())
        return;
    const output = (method, values) => addLog("codigo", "custom-action.js", method, values.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" "));
    const sandbox = { ...helpers(socket, enviado), console: { log: (...values) => output("console.log", values), info: (...values) => output("console.info", values), warn: (...values) => output("console.warn", values), error: (...values) => output("console.error", values) }, Buffer, JSON, setTimeout, clearTimeout };
    const source = customCode.replace(/export\s+default\s+async\s+function\s+execute/, "async function execute").replace(/export\s+default\s+function\s+execute/, "function execute");
    const script = new Script(`(async () => { ${source}\n if (typeof execute !== "function") throw new Error("O código precisa exportar execute(client, enviado)"); return execute(client, enviado); })()`);
    try {
        await Promise.race([script.runInNewContext(sandbox), new Promise((_, reject) => setTimeout(() => reject(new Error("Tempo limite do código excedido.")), 8000))]);
    }
    catch (error) {
        output("console.error", [error instanceof Error ? error.message : String(error)]);
    }
}
async function conectar(phoneNumber = pairingPhone) {
    if (socket && connection !== "disconnected")
        return;
    mkdirSync(authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const client = makeWASocket({ auth: state, printQRInTerminal: false, logger, generateHighQualityLinkPreview: false });
    socket = client;
    client.ev.on("creds.update", saveCreds);
    client.ev.on("connection.update", async ({ connection: next, lastDisconnect }) => {
        connection = next ?? connection;
        addLog("avancados", "connection.update", `status=${connection}`, lastDisconnect ? String(lastDisconnect.error ?? "disconnect") : "");
        if (connection === "open")
            addLog("resumidos", "Sessão conectada", "Baileys pronto para receber mensagens", "");
        if (connection === "close") {
            socket = null;
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect)
                setTimeout(() => conectar(phoneNumber).catch((error) => addLog("avancados", "reconnect.error", String(error))), 1500);
        }
        if (!state.creds.registered && phoneNumber && connection === "connecting") {
            setTimeout(async () => { if (socket && !state.creds.registered) {
                pairingCode = await socket.requestPairingCode(phoneNumber);
                addLog("resumidos", "Pairing code", "Código gerado no servidor Termux", pairingCode);
            } }, 1800);
        }
    });
    client.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify")
            return;
        for (const message of messages) {
            const enviado = await normalizarEnviado(message);
            addLog("resumidos", "Mensagem recebida", `FROM_ID: ${enviado.from} · SENDER: ${enviado.sender}`, `ARGUMENTS: ${enviado.mimetyped.command ?? `[${enviado.mimetyped.mimetype}]`}`);
            addLog("avancados", "messages.upsert", `key.id=${enviado.key.id} · fromMe=${enviado.fromMe}`, `mimetype=${enviado.mimetyped.mimetype} · quoted=${Boolean(enviado.quotedMessage)}`, enviado);
            await executarCodigo(enviado);
        }
    });
}
function json(res, status, payload) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" });
    res.end(JSON.stringify(payload));
}
async function body(req) {
    let raw = "";
    for await (const chunk of req)
        raw += chunk;
    return raw ? JSON.parse(raw) : {};
}
const server = createServer(async (req, res) => {
    if (req.method === "OPTIONS")
        return json(res, 204, {});
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
        if (url.pathname === "/api/v1/health")
            return json(res, 200, { status: "ok", service: "flowbot-termux", version: "0.1.0", timestamp: new Date().toISOString(), database: "connected" });
        if (url.pathname === "/api/v1/server/capabilities")
            return json(res, 200, { apiVersion: "v1", backendVersion: "termux-0.1.0", security: { localHttp: true, remoteHttpsRequired: false, jwt: false, websocket: false }, features: { sessions: true, flows: true, flowEditor: true, executions: true, customActions: true } });
        if (url.pathname === "/api/v1/session/status")
            return json(res, 200, { status: connection, pairingCode, hasAuth: existsSync(authDir) });
        if (url.pathname === "/api/v1/session/connect" && req.method === "POST") {
            const input = await body(req);
            await conectar(input.phoneNumber ?? pairingPhone);
            return json(res, 202, { status: "connecting", pairingCode });
        }
        if (url.pathname === "/api/v1/session/disconnect" && req.method === "POST") {
            socket?.end(undefined);
            socket = null;
            connection = "disconnected";
            return json(res, 200, { status: connection });
        }
        if (url.pathname === "/api/v1/logs" && req.method === "GET") {
            const level = url.searchParams.get("level");
            const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
            return json(res, 200, logs.filter((item) => !level || item.level === level).slice(-limit));
        }
        if (url.pathname === "/api/v1/dashboard")
            return json(res, 200, { server: { status: connection === "open" ? "online" : "offline", version: "termux-0.1.0", uptimeSeconds: Math.floor(process.uptime()) }, sessions: { active: connection === "open" ? 1 : 0, total: 1 }, messages: { received: logs.filter((item) => item.title === "Mensagem recebida").length, sent: 0 }, flows: { active: customCode ? 1 : 0, executionsInProgress: 0 }, failuresRecent: logs.filter((item) => item.title === "console.error").length });
        if (url.pathname === "/api/v1/messages/send" && req.method === "POST") {
            const input = await body(req);
            if (!socket)
                return json(res, 409, { error: { message: "Sessão Baileys desconectada." } });
            const sent = await enviarTexto(socket, String(input.chatId), String(input.text));
            addLog("resumidos", "Mensagem enviada", `CHAT: ${input.chatId}`, String(input.text));
            return json(res, 200, { messageId: sent?.key?.id ?? "sent" });
        }
        if (url.pathname === "/api/v1/custom-code" && req.method === "POST") {
            const input = await body(req);
            customCode = String(input.code ?? "");
            mkdirSync(dirname(codeFile), { recursive: true });
            writeFileSync(codeFile, customCode, "utf8");
            addLog("codigo", "custom-code", "Código salvo no Termux", `${customCode.split("\n").length} linhas`);
            return json(res, 200, { saved: true, file: codeFile });
        }
        return json(res, 404, { error: { message: "Rota não encontrada." } });
    }
    catch (error) {
        addLog("avancados", "server.error", error instanceof Error ? error.message : String(error));
        return json(res, 500, { error: { message: error instanceof Error ? error.message : "Erro interno." } });
    }
});
server.listen(port, host, () => {
    console.log(`FlowBot Termux em http://${host}:${port}`);
    if (pairingPhone)
        conectar(pairingPhone).catch((error) => addLog("avancados", "startup.error", String(error)));
});
