# Deploy gratuito sugerido (Node)

## Backend (Render)
1. Conecte o repositorio do GitHub.
2. Build command: `npm install`
3. Start command: `npm start`
4. Variaveis de ambiente:
   - `SESSION_SECRET` (uma string longa e segura)
   - `DB_PATH` (opcional, caminho do SQLite)

## Dominio/subdominio
1. No seu provedor DNS, crie um CNAME `fitness` apontando para o dominio fornecido pelo Render.
2. No Render, configure o custom domain `fitness.katello.com.br`.
3. Aguarde propagacao do DNS.

## Observacao sobre email/WhatsApp
- Email via SMTP e possivel, mas provedores gratuitos costumam limitar volume.
- Para escala/entregabilidade, o ideal e usar SendGrid, Mailgun ou Brevo.
