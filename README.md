# ClovaChat Website

Initial static website for ClovaChat, designed to match the dark neon desktop app.

## Local Preview

```bash
npm install
npm start
```

Open `http://localhost:4173`.

Customers can create an account at `/signup` and sign in at `/login`.

Admin accounts are not created from the public website. To bootstrap the first admin on a fresh deployment, set `ADMIN_USERNAME` and `ADMIN_PASSWORD` before starting the app. Once an admin exists, those variables will not create additional admins.

The admin dashboard at `/admin` can generate:

- trial licenses for a custom number of days, weeks, months, or years
- lifetime licenses

License codes are 62 characters and are bound to the first device that activates them through `/api/licenses/activate`.

## CapRover

This repo includes:

- `captain-definition`
- `Dockerfile`

CapRover can build and serve the Node app on port 80.

Recommended environment variables:

- `SESSION_SECRET`: long random string used to sign login cookies
- `DATA_DIR`: persistent data directory for admin users and license codes, defaults to `./data`
- `COOKIE_SECURE`: set to `true` when serving only over HTTPS
- `ADMIN_USERNAME`: optional first-admin bootstrap username
- `ADMIN_PASSWORD`: optional first-admin bootstrap password
