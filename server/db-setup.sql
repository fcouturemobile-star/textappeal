-- Text Appeal Freemium System - MySQL Schema
-- No foreign keys used (avoids Hostinger collation/charset conflicts)
-- Referential integrity enforced at the application level

SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS user_sessions;
DROP TABLE IF EXISTS usage_log;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS stripe_config;

SET FOREIGN_KEY_CHECKS = 1;

CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100) DEFAULT '',
  plan ENUM('free', 'pro', 'admin_free') NOT NULL DEFAULT 'free',
  stripe_customer_id VARCHAR(255) DEFAULT NULL,
  stripe_subscription_id VARCHAR(255) DEFAULT NULL,
  subscription_status ENUM('none', 'active', 'past_due', 'canceled') NOT NULL DEFAULT 'none',
  requests_this_month INT NOT NULL DEFAULT 0,
  month_reset_date DATE NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_email (email),
  INDEX idx_stripe_customer (stripe_customer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE usage_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  request_type ENUM('translate', 'rewrite') NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_date (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE user_sessions (
  token VARCHAR(128) PRIMARY KEY,
  user_id INT NOT NULL,
  expires_at BIGINT NOT NULL,
  INDEX idx_user (user_id),
  INDEX idx_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE stripe_config (
  id INT PRIMARY KEY DEFAULT 1,
  secret_key VARCHAR(255) DEFAULT '',
  publishable_key VARCHAR(255) DEFAULT '',
  price_id VARCHAR(255) DEFAULT '',
  webhook_secret VARCHAR(255) DEFAULT '',
  monthly_price_cad DECIMAL(10,2) DEFAULT 20.00,
  free_requests_per_month INT DEFAULT 30,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO stripe_config (id, free_requests_per_month, monthly_price_cad)
VALUES (1, 30, 20.00);
