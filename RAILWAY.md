# Railway deploy

> Superseded for production by [`docs/deployment/railway-deployment-plan.md`](docs/deployment/railway-deployment-plan.md)
> (two services: `resulio-frontend` on resulio.co, `resulio-api` on api.resulio.co). The steps below describe the
> original single-service setup and must not be used for the production cut-over.

This app has a production `Dockerfile` (`pnpm build` then `node dist/index.js`) and a health check at `/api/health`.

1. Create a Railway project and add a MySQL plugin.
2. Copy variables from `.env.example` into Railway Variables. Set `DATABASE_URL` from the plugin, a random `SESSION_SECRET` (32+ chars), and `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
3. In Google Cloud Console add the authorised redirect URI `https://<service>.up.railway.app/api/auth/google/callback` (or set `GOOGLE_REDIRECT_URI` explicitly).
4. Apply migrations once against the Railway database: `DATABASE_URL=<railway url> pnpm db:migrate`.
5. Deploy from this repository root (Dockerfile builder).
6. Open `https://<service>.up.railway.app/api/health` and confirm `{"status":"ok"}`, then sign in with Google.

Demo login is always disabled when `NODE_ENV=production`; Google is the only sign-in method there.
