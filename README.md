# Quipora Website

Website for Quipora, with customer accounts and an admin license dashboard.

## Local Preview

```bash
npm install
npm start
```

Open `http://localhost:4173`.

Customers can create an account at `/signup` and sign in at `/login`.

Create the first admin account at `/admin/setup` on a fresh deployment. That setup route locks after one admin exists, so it cannot create additional admins. You can also bootstrap the first admin by setting `ADMIN_USERNAME` and `ADMIN_PASSWORD` before starting the app; those variables are ignored once an admin exists.

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
- `mongoDB_URI`: MongoDB connection string for production user and license storage
- `MONGODB_DB`: optional MongoDB database name, defaults to `clovachat` (legacy name kept as the default so existing deployments don't need an env change; set it explicitly to use a different database)
- `DATA_DIR`: persistent data directory for admin users and license codes, defaults to `./data`
- `COOKIE_SECURE`: set to `true` when serving only over HTTPS
- `ADMIN_USERNAME`: optional first-admin bootstrap username
- `ADMIN_PASSWORD`: optional first-admin bootstrap password
- `GITHUB_TOKEN`: GitHub personal access token with read access to the Quipora app's `Chatterbox` GitHub repo releases (required for the account/admin download panel, since the app repo is private — the repo itself is intentionally still named Chatterbox)
- `GITHUB_RELEASES_REPO`: optional, defaults to `MNIKevin202/Chatterbox`

Signed-in customers and admins see a Download panel with the latest release version, notes, and installer download buttons. The server proxies GitHub's release assets through `/api/releases/download/:id` using `GITHUB_TOKEN`, since GitHub only serves private-repo release assets to authenticated requests.
