import mysql from 'mysql2/promise';
import 'dotenv/config';

// A pool keeps several connections open and reuses them,
// instead of opening a new connection for every request.
export const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectionLimit: 10,
});
