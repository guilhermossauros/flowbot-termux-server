# FlowBot Termux Server

Runtime independente para executar um bot de WhatsApp diretamente no Android usando Termux, Node.js e Baileys.

Este repositório é o pacote mínimo de operação. Ele não inclui o APK, o preview desktop nem o backend Fastify. O APK FlowBot Studio se conecta a este servidor pela rede local para configurar o bot, editar códigos e acompanhar os logs.

> **Status:** alpha funcional. Use em ambiente controlado até configurar HTTPS, autenticação de rede e isolamento adequado para códigos personalizados.

## O que este servidor faz

- mantém a sessão Baileys no próprio aparelho;
- gera pairing code para conectar o WhatsApp;
- expõe uma API HTTP local para o APK;
- normaliza mensagens no objeto `enviado`;
- executa o código personalizado salvo em `data/custom-action.js`;
- separa logs resumidos, avançados e de código;
- oferece helpers para mensagens, reações, stickers, mídia, enquetes e grupos;
- persiste a autenticação em `data/auth`.

## Requisitos

- Android com [Termux](https://termux.dev/) atualizado;
- Node.js 20 ou superior instalado pelo Termux;
- conexão local entre o aparelho que executa o APK e o aparelho que executa este servidor;
- uma conta WhatsApp para pareamento.

## Instalação no Termux

```bash
pkg update && pkg upgrade
pkg install nodejs git
git clone <URL_DO_REPOSITORIO> flowbot-termux-server
cd flowbot-termux-server
npm install --omit=dev
cp .env.example .env
```

O pacote já contém `dist/main.js`, portanto o servidor pode ser iniciado sem Metro, Android Studio ou computador conectado:

```bash
npm start
```

Para iniciar automaticamente com um número de pareamento:

```bash
PAIRING_PHONE=5511999999999 npm start
```

Substitua o número pelo formato internacional, somente com dígitos. Exemplo para Brasil: `5511999999999`.

## Configuração

Edite o arquivo `.env` quando precisar alterar a porta, o endereço de escuta ou os diretórios persistentes:

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `FLOWBOT_PORT` | `3000` | Porta HTTP da API. |
| `FLOWBOT_HOST` | `0.0.0.0` | Interface de rede que aceita conexões. |
| `FLOWBOT_AUTH_DIR` | `./data/auth` | Credenciais persistentes da sessão Baileys. |
| `FLOWBOT_CODE_FILE` | `./data/custom-action.js` | Código personalizado executado para cada mensagem. |
| `PAIRING_PHONE` | vazio | Número usado para solicitar pairing code na inicialização. |

Descubra o IP do aparelho no Termux com:

```bash
ip addr show wlan0
```

No APK, use o endereço do aparelho, por exemplo:

```text
http://192.168.0.20:3000
```

O modo local não exige login no APK. A sessão e as credenciais do WhatsApp ficam no servidor Termux.

## Pareamento e ciclo de vida

1. Inicie o servidor com `npm start`.
2. No APK, informe a URL do Termux e toque em **Conectar Termux sem login**.
3. Se necessário, envie `POST /api/v1/session/connect` com o número de telefone.
4. Consulte `GET /api/v1/session/status` para acompanhar o pairing code e o estado.
5. Depois do primeiro pareamento, mantenha `data/auth` preservado para reutilizar a sessão.

Exemplo:

```bash
curl -X POST http://127.0.0.1:3000/api/v1/session/connect \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber":"5511999999999"}'
```

## API HTTP

Todas as respostas são JSON e usam a base `/api/v1`.

| Método | Endpoint | Finalidade |
| --- | --- | --- |
| `GET` | `/health` | Verificar se o processo está ativo. |
| `GET` | `/server/capabilities` | Descobrir recursos e versão da API. |
| `GET` | `/session/status` | Consultar conexão e pairing code. |
| `POST` | `/session/connect` | Iniciar ou solicitar pareamento. |
| `POST` | `/session/disconnect` | Encerrar a sessão atual. |
| `GET` | `/logs?level=resumidos` | Ler logs resumidos, avançados ou de código. |
| `GET` | `/dashboard` | Obter um resumo operacional. |
| `POST` | `/messages/send` | Enviar mensagem de texto. |
| `POST` | `/custom-code` | Salvar o código personalizado. |

Exemplo de saúde:

```bash
curl http://127.0.0.1:3000/api/v1/health
```

Exemplo de envio:

```bash
curl -X POST http://127.0.0.1:3000/api/v1/messages/send \
  -H "Content-Type: application/json" \
  -d '{"chatId":"5511999999999@s.whatsapp.net","text":"Olá pelo FlowBot"}'
```

## Mensagem normalizada: `enviado`

O runtime converte a mensagem recebida do Baileys para uma estrutura previsível, inspirada no formato usado pelo Baileys-Natsuki:

```js
{
  key,
  message,
  isGroup,
  sender,
  from,
  chat,
  fromMe,
  mimetyped: {
    mimetype,
    command
  },
  quotedMessage,
  quotedMessageSender,
  mentionedJidList,
  metadata,
  mensagem
}
```

Campos mais usados:

| Campo | Conteúdo |
| --- | --- |
| `enviado.sender` | JID do remetente. |
| `enviado.chat` | JID do chat ou grupo. |
| `enviado.from` | JID remoto recebido na mensagem. |
| `enviado.message` | Payload original do Baileys. |
| `enviado.mimetyped.command` | Texto ou legenda tratada. |
| `enviado.mimetyped.mimetype` | Tipo tratado: `text`, `image`, `video`, `audio`, `sticker` etc. |
| `enviado.isGroup` | Indica se a mensagem veio de grupo. |
| `enviado.quotedMessage` | Mensagem citada, quando existir. |
| `enviado.mentionedJidList` | Lista de JIDs mencionados. |
| `enviado.metadata` | Metadados do grupo quando disponíveis. |

## Código personalizado

O arquivo configurado em `FLOWBOT_CODE_FILE` deve declarar `execute(client, enviado)`. O runtime aceita também os templates `export default async function execute(...)` usados no editor do APK.

Exemplo de saudação:

```js
async function execute(client, enviado) {
  const texto = enviado.mimetyped.command?.toLowerCase();

  if (texto === "oi" || texto === "olá") {
    await responderTexto(client, enviado.chat, `Olá, ${enviado.sender}!`, enviado);
  }
}
```

Helpers disponíveis:

| Helper | Uso |
| --- | --- |
| `enviarTexto(client, chat, texto)` | Enviar texto sem citação. |
| `responderTexto(client, chat, texto, citado)` | Responder citando uma mensagem. |
| `reagir(client, chat, mensagem, emoji)` | Enviar reação. |
| `enviarFigurinha(client, chat, sticker)` | Enviar buffer de figurinha. |
| `baixarMidia(client, mensagem)` | Baixar imagem, vídeo ou áudio. |
| `deletarMensagem(client, enviado, citada)` | Apagar mensagem. |
| `enviarEnquete(client, chat, nome, opcoes)` | Criar enquete. |
| `adicionarParticipante(client, grupo, jid)` | Adicionar participante. |
| `removerParticipante(client, grupo, jid)` | Remover participante. |
| `promoverParticipante(client, grupo, jid)` | Promover a administrador. |
| `rebaixarParticipante(client, grupo, jid)` | Remover privilégio de administrador. |

Exemplo de grupo:

```js
async function execute(client, enviado) {
  if (enviado.isGroup && enviado.mimetyped.command === "promover") {
    await promoverParticipante(client, enviado.chat, enviado.sender);
  }
}
```

## Logs

Use o parâmetro `level` para separar as saídas:

- `resumidos`: mensagens recebidas, mensagens enviadas e eventos essenciais;
- `avancados`: `messages.upsert`, conexão, metadados e erros técnicos;
- `codigo`: `console.log`, `console.info`, `console.warn` e `console.error` dos scripts.

Exemplo:

```bash
curl "http://127.0.0.1:3000/api/v1/logs?level=codigo&limit=50"
```

O runtime mantém até 500 eventos em memória. Reiniciar o processo limpa o histórico dos logs, mas não apaga a sessão em `data/auth` nem o código em `data/custom-action.js`.

## Desenvolvimento

Para editar o servidor no próprio Termux:

```bash
npm install
npm run build
npm start
```

Durante o desenvolvimento:

```bash
npm run dev
```

O build gera `dist/main.js`. O arquivo já compilado é versionado para permitir execução com `npm install --omit=dev` em um aparelho sem compilador TypeScript.

## Estrutura do repositório

```text
flowbot-termux-server/
├── data/
│   └── .gitkeep
├── dist/
│   ├── main.js
│   ├── main.d.ts
│   └── main.js.map
├── src/
│   └── main.ts
├── .env.example
├── .gitignore
├── package-lock.json
├── package.json
├── SECURITY.md
└── tsconfig.json
```

Nunca versione `data/auth`, `.env` ou `data/custom-action.js`.

## Limitações conhecidas

- a integração Baileys é não oficial e pode exigir ajustes após mudanças do WhatsApp ou da biblioteca;
- o modo HTTP sem login é adequado para rede local confiável, não para exposição direta na internet;
- a execução com `node:vm` possui limite de tempo, mas ainda não é um sandbox completo;
- pairing code e gerenciamento avançado de sessão devem ser tratados como recursos experimentais nesta versão.

## Licença

Nenhuma licença open source foi definida. Todos os direitos permanecem reservados ao autor até que uma licença seja adicionada.
