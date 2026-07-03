# ClovaChat Website

Initial static website for ClovaChat, designed to match the dark neon desktop app.

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
- `MONGODB_DB`: optional MongoDB database name, defaults to `clovachat`
- `DATA_DIR`: persistent data directory for admin users and license codes, defaults to `./data`
- `COOKIE_SECURE`: set to `true` when serving only over HTTPS
- `ADMIN_USERNAME`: optional first-admin bootstrap username
- `ADMIN_PASSWORD`: optional first-admin bootstrap password
