import express from 'express';
import { randomInt } from 'node:crypto';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { UAParser } from 'ua-parser-js';
import { pool } from './db.js';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('Missing JWT_SECRET in .env');
  process.exit(1);
}

// Used to keep login timing the same whether or not the email exists
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'; // 62 chars
const CODE_LENGTH = 7; // 62^7 is about 3.5 trillion possible codes

function generateCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[randomInt(ALPHABET.length)];
  }
  return code;
}

function isValidHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// ---------- Auth ----------

// Reads "Authorization: Bearer <token>", verifies it, and sets req.userId
function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Login required.' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = Number(payload.sub);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body ?? {};

  if (typeof email !== 'string' || email.length > 255 || !EMAIL_RE.test(email.trim())) {
    return res.status(400).json({ error: 'Provide a valid email.' });
  }
  // bcrypt only uses the first 72 bytes, so we cap the length
  if (typeof password !== 'string' || password.length < 8 || password.length > 72) {
    return res.status(400).json({ error: 'Password must be 8 to 72 characters.' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const [result] = await pool.execute(
      'INSERT INTO users (email, password_hash) VALUES (?, ?)',
      [email.trim().toLowerCase(), passwordHash]
    );
    res.status(201).json({ id: result.insertId, email: email.trim().toLowerCase() });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Email already registered.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Provide email and password.' });
  }

  try {
    const [rows] = await pool.execute(
      'SELECT id, password_hash FROM users WHERE email = ?',
      [email.trim().toLowerCase()]
    );
    const user = rows[0];

    // Always run bcrypt.compare, even for unknown emails, so timing doesn't reveal which emails exist
    const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = jwt.sign({ sub: String(user.id) }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ---------- Links ----------

// Create a short link (login required)
app.post('/api/links', requireAuth, async (req, res) => {
  const { url } = req.body ?? {};

  if (typeof url !== 'string' || url.length > 2048 || !isValidHttpUrl(url)) {
    return res.status(400).json({ error: 'Provide a valid http(s) URL (max 2048 chars).' });
  }

  // Random codes can (very rarely) collide. The UNIQUE constraint on links.code
  // makes MySQL reject a duplicate, so we just catch that error and try a new code.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    try {
      await pool.execute(
        'INSERT INTO links (code, original_url, user_id) VALUES (?, ?, ?)',
        [code, url, req.userId]
      );
      return res.status(201).json({ code, shortUrl: `${BASE_URL}/${code}`, originalUrl: url });
    } catch (err) {
      if (err.code !== 'ER_DUP_ENTRY') {
        console.error(err);
        return res.status(500).json({ error: 'Something went wrong.' });
      }
      // duplicate code -> loop and try again
    }
  }
  res.status(500).json({ error: 'Could not generate a unique code, please retry.' });
});

// List the logged-in user's links with click counts
app.get('/api/links', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT l.code, l.original_url AS originalUrl, l.created_at AS createdAt, COUNT(c.id) AS clicks
       FROM links l
       LEFT JOIN clicks c ON c.link_id = l.id
       WHERE l.user_id = ?
       GROUP BY l.id
       ORDER BY l.created_at DESC`,
      [req.userId]
    );
    res.json(rows.map((r) => ({ ...r, shortUrl: `${BASE_URL}/${r.code}` })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// Stats for one of your links: total clicks, clicks per day, devices, browsers, top referrers
app.get('/api/links/:code/stats', requireAuth, async (req, res) => {
  const { code } = req.params;

  try {
    const [links] = await pool.execute(
      'SELECT id, original_url, created_at FROM links WHERE code = ? AND user_id = ?',
      [code, req.userId]
    );
    // Someone else's link looks the same as a missing one, so codes can't be probed
    if (links.length === 0) {
      return res.status(404).json({ error: 'Link not found.' });
    }
    const link = links[0];

    const [[{ total }]] = await pool.execute(
      'SELECT COUNT(*) AS total FROM clicks WHERE link_id = ?',
      [link.id]
    );

    const [perDay] = await pool.execute(
      `SELECT DATE_FORMAT(clicked_at, '%Y-%m-%d') AS date, COUNT(*) AS clicks
       FROM clicks
       WHERE link_id = ? AND clicked_at >= NOW() - INTERVAL 30 DAY
       GROUP BY date
       ORDER BY date`,
      [link.id]
    );

    const [referrers] = await pool.execute(
      `SELECT referrer, COUNT(*) AS clicks
       FROM clicks
       WHERE link_id = ? AND referrer IS NOT NULL
       GROUP BY referrer
       ORDER BY clicks DESC
       LIMIT 5`,
      [link.id]
    );

    // Group by user agent in SQL (few distinct values), then parse each one in JS
    const [agents] = await pool.execute(
      'SELECT user_agent, COUNT(*) AS clicks FROM clicks WHERE link_id = ? GROUP BY user_agent',
      [link.id]
    );
    const devices = {};
    const browsers = {};
    for (const { user_agent, clicks } of agents) {
      const ua = UAParser(user_agent || '');
      const device = ua.device.type || 'desktop'; // the parser leaves type empty for desktops
      const browser = ua.browser.name || 'Unknown';
      devices[device] = (devices[device] || 0) + clicks;
      browsers[browser] = (browsers[browser] || 0) + clicks;
    }

    res.json({
      code,
      originalUrl: link.original_url,
      totalClicks: total,
      clicksPerDay: perDay,
      devices,
      browsers,
      topReferrers: referrers,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// Redirect: must be defined AFTER the /api routes
app.get('/:code', async (req, res) => {
  const { code } = req.params;

  if (!/^[0-9A-Za-z]{1,10}$/.test(code)) {
    return res.status(404).json({ error: 'Link not found.' });
  }

  try {
    const [rows] = await pool.execute(
      'SELECT id, original_url FROM links WHERE code = ?',
      [code]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Link not found.' });
    }

    const link = rows[0];

    // Log the click in the background: don't wait for it, and never let it break the redirect
    pool.execute(
      'INSERT INTO clicks (link_id, referrer, user_agent) VALUES (?, ?, ?)',
      [
        link.id,
        req.get('referer')?.slice(0, 2048) || null,
        req.get('user-agent')?.slice(0, 512) || null,
      ]
    ).catch((err) => console.error('Failed to log click:', err));

    // 302 = temporary redirect
    res.redirect(302, link.original_url);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.listen(PORT, () => console.log(`Shortly running on ${BASE_URL}`));