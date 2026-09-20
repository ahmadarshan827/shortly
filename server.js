import express from 'express';
import { randomInt } from 'node:crypto';
import 'dotenv/config';
import { UAParser } from 'ua-parser-js';
import { pool } from './db.js';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

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

// Create a short link
app.post('/api/links', async (req, res) => {
  const { url } = req.body ?? {};

  if (typeof url !== 'string' || url.length > 2048 || !isValidHttpUrl(url)) {
    return res.status(400).json({ error: 'Provide a valid http(s) URL (max 2048 chars).' });
  }

  // Random codes can (very rarely) collide. The UNIQUE constraint on links.code
  // makes MySQL reject a duplicate, so we just catch that error and try a new code.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    try {
      await pool.execute('INSERT INTO links (code, original_url) VALUES (?, ?)', [code, url]);
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

// Stats for one link: total clicks, clicks per day, devices, browsers, top referrers
app.get('/api/links/:code/stats', async (req, res) => {
  const { code } = req.params;

  try {
    const [links] = await pool.execute(
      'SELECT id, original_url, created_at FROM links WHERE code = ?',
      [code]
    );
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