# Shortly

A URL shortener with per-user accounts and click analytics, built with Node.js, Express and MySQL.

Users register, log in, create short links, and see how each link is used: total clicks, clicks per day, device and browser breakdown, and top referrers.

## Features

- **Short links:** random 7-character base62 codes (about 3.5 trillion combinations), with automatic retry on the rare collision
- **JWT authentication:** register and login with bcrypt-hashed passwords and 1-hour access tokens
- **Per-user ownership:** you can only list and view stats for your own links
- **Click analytics:** every redirect records time, referrer and user agent; stats parse device and browser on read
- **Rate limiting:** per-IP limits on login/register, link creation and redirects
- **Safe redirects:** only `http` and `https` URLs are accepted, and clicks are logged in the background so a logging failure never breaks a redirect

## Tech stack

Node.js, Express 5, MySQL (`mysql2`), `jsonwebtoken`, `bcryptjs`, `express-rate-limit`, `ua-parser-js`

## API

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/register` | No | Create an account (`email`, `password` of 8 to 72 characters) |
| POST | `/api/auth/login` | No | Returns a JWT (`token`) |
| POST | `/api/links` | Yes | Create a short link from `{ "url": "https://..." }` |
| GET | `/api/links` | Yes | List your links with click counts |
| GET | `/api/links/:code/stats` | Yes | Total clicks, clicks per day (last 30 days), devices, browsers, top referrers |
| GET | `/:code` | No | Redirects (302) to the original URL and records the click |

Authenticated requests send the header `Authorization: Bearer <token>`.

### Example stats response

```json
{
  "code": "MEPiSKI",
  "originalUrl": "https://example.com",
  "totalClicks": 5,
  "clicksPerDay": [{ "date": "2026-09-20", "clicks": 5 }],
  "devices": { "desktop": 5 },
  "browsers": { "Chrome": 5 },
  "topReferrers": []
}
```

## Getting started

**Requirements:** Node.js 20+ and MySQL

1. Clone the repo and install dependencies:
   ```bash
   git clone https://github.com/ahmadarshan827/shortly.git
   cd shortly
   npm install
   ```
2. Create the database and tables:
   ```bash
   mysql -u root -p < schema.sql
   ```
3. Copy `.env.example` to `.env` and fill in your values:
   ```
   PORT=3000
   BASE_URL=http://localhost:3000
   DB_HOST=localhost
   DB_USER=root
   DB_PASSWORD=your_mysql_password
   DB_NAME=shortly
   JWT_SECRET=a_long_random_string
   ```
   Generate a secret with:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
4. Start the server:
   ```bash
   npm run dev
   ```

### Try it (PowerShell)

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/auth/register -ContentType "application/json" -Body '{"email":"you@example.com","password":"mypassword123"}'
$r = Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/auth/login -ContentType "application/json" -Body '{"email":"you@example.com","password":"mypassword123"}'
$h = @{ Authorization = "Bearer $($r.token)" }
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/links -Headers $h -ContentType "application/json" -Body '{"url":"https://example.com"}'
```

### Try it (curl)

```bash
curl -X POST localhost:3000/api/auth/register -H "Content-Type: application/json" -d '{"email":"you@example.com","password":"mypassword123"}'
TOKEN=$(curl -s -X POST localhost:3000/api/auth/login -H "Content-Type: application/json" -d '{"email":"you@example.com","password":"mypassword123"}' | jq -r .token)
curl -X POST localhost:3000/api/links -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"url":"https://example.com"}'
```

## Design decisions

- **Random codes instead of encoding the row ID.** Sequential codes are guessable. Random codes can collide, so the `UNIQUE` index on `links.code` rejects duplicates and the insert is retried.
- **302, not 301.** A 301 is cached by browsers, so repeat visits would skip the server and never be counted.
- **Parameterized queries everywhere** to prevent SQL injection.
- **Parse user agents at read time.** The redirect stays fast and the raw data is kept, so parsing can change later without losing history.
- **404 for other people's links.** Stats for a link you don't own look the same as a missing link, so codes can't be probed.
- **Login timing is constant.** A dummy hash is compared when the email doesn't exist, so response time doesn't reveal which emails are registered.

## Limitations and next steps

- Rate-limit counters are stored in memory, so multiple server instances would each keep their own count. A shared store such as Redis would fix that.
- Access tokens expire after 1 hour and there is no refresh flow yet.
- A React dashboard and a public deployment are planned.

## Project structure

```
server.js     routes, auth, rate limiting, analytics
db.js         MySQL connection pool
schema.sql    users, links and clicks tables
```
