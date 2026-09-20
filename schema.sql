CREATE DATABASE IF NOT EXISTS shortly;
USE shortly;

CREATE TABLE IF NOT EXISTS users (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS links (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code         VARCHAR(10) NOT NULL UNIQUE,          -- the short code; UNIQUE also creates the index used by redirects
  original_url VARCHAR(2048) NOT NULL,
  user_id      INT UNSIGNED NULL,                    -- NULL for now; filled in once we add login
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- Not used yet. We'll start logging clicks in the next step.
CREATE TABLE IF NOT EXISTS clicks (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  link_id    BIGINT UNSIGNED NOT NULL,
  clicked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  referrer   VARCHAR(2048) NULL,
  user_agent VARCHAR(512) NULL,
  FOREIGN KEY (link_id) REFERENCES links(id) ON DELETE CASCADE,
  INDEX idx_link_time (link_id, clicked_at)
);
