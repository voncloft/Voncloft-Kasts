CREATE TABLE IF NOT EXISTS ps_users (
 id BIGINT PRIMARY KEY AUTO_INCREMENT,
 username VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
 password_hash VARCHAR(255) NOT NULL,
 queue_revision BIGINT NOT NULL DEFAULT 0,
 queue_json LONGTEXT NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS ps_devices (
 user_id BIGINT NOT NULL,
 device_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 caption VARCHAR(255) NOT NULL,
 device_type VARCHAR(32) NOT NULL,
 PRIMARY KEY(user_id, device_id),
 FOREIGN KEY(user_id) REFERENCES ps_users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS ps_subscriptions (
 user_id BIGINT NOT NULL,
 url_hash CHAR(64) CHARACTER SET ascii NOT NULL,
 url TEXT NOT NULL,
 active INTEGER NOT NULL,
 changed_at BIGINT NOT NULL,
 PRIMARY KEY(user_id, url_hash),
 FOREIGN KEY(user_id) REFERENCES ps_users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS ps_actions (
 user_id BIGINT NOT NULL,
 action_key CHAR(64) CHARACTER SET ascii NOT NULL,
 action_json LONGTEXT NOT NULL,
 played_at BIGINT NOT NULL,
 received_at BIGINT NOT NULL,
 PRIMARY KEY(user_id, action_key),
 FOREIGN KEY(user_id) REFERENCES ps_users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS ps_queue_history (
 user_id BIGINT NOT NULL,
 revision BIGINT NOT NULL,
 queue_json LONGTEXT NOT NULL,
 changed_at BIGINT NOT NULL,
 PRIMARY KEY(user_id, revision),
 FOREIGN KEY(user_id) REFERENCES ps_users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
