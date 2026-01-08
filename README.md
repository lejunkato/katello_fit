# Fitness Katello (Node)

Aplicacao web simples para criar desafios fitness, registrar exercicios e gerar ranking.

## Funcionalidades
- Login e cadastro com email/senha
- Qualquer usuario pode criar desafios
- Participacao e registro de exercicios por participantes
- Ranking com progresso por desafio
- Espaco reservado para resumos semanais (envio por email/WhatsApp em breve)

## Como rodar localmente
```bash
npm install
npm run dev
```
Acesse `http://localhost:3000`.

## Banco de dados
Por padrao usa SQLite (`app.db`). Nao versionar o arquivo.

## Variaveis de ambiente
Crie um `.env` baseado em `.env.example`.

## Deploy (sugestao gratuita)
- **Render** para hospedar o backend (Node)
- **Supabase** ou **Neon** para Postgres gratuito (quando precisar)

Passos basicos:
1. Suba o repositorio no GitHub.
2. Crie o servico Node no Render.
3. Configure as variaveis de ambiente.

Para subdominio `fitness.katello.com.br`, aponte um CNAME no seu provedor de DNS para o endereco gerado pelo Render.
