# Segurança

O servidor Termux foi pensado para uso local ou em uma rede confiável.

- não publique a porta HTTP diretamente na internet;
- mantenha `data/auth` e `.env` fora do Git;
- use firewall, VPN ou um proxy HTTPS autenticado quando o servidor estiver fora do aparelho;
- não execute código personalizado de terceiros sem revisar o conteúdo;
- a execução de scripts usa `node:vm` no protótipo e ainda não deve ser considerada um sandbox de segurança completo;
- remova ou masque números, JIDs e conteúdo de mensagens antes de compartilhar logs.

Para reportar uma vulnerabilidade, abra uma issue privada no repositório ou entre em contato com o mantenedor antes de publicar detalhes exploráveis.
