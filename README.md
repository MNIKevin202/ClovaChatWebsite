# ClovaChat Website

Initial static website for ClovaChat, designed to match the dark neon desktop app.

## Local Preview

```bash
npm install
npm start
```

Open `http://localhost:4173`.

On first run, visit `/login` to create the first admin account. After the first admin exists, `/login` switches to the normal login flow.

## CapRover

This repo includes:

- `captain-definition`
- `Dockerfile`

CapRover can build and serve the Node app on port 80.

Recommended environment variables:

- `SESSION_SECRET`: long random string used to sign login cookies
- `DATA_DIR`: persistent data directory, defaults to `./data`
- `COOKIE_SECURE`: set to `true` when serving only over HTTPS
