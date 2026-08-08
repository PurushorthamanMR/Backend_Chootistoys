CREATE TABLE IF NOT EXISTS user_roles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(20) NOT NULL UNIQUE
);

INSERT INTO user_roles (name) VALUES ('SuperAdmin'), ('Admin'), ('Seller'), ('Customer')
ON DUPLICATE KEY UPDATE name = VALUES(name);

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(150) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  phone VARCHAR(30),
  address VARCHAR(255),
  shop_name VARCHAR(150),
  city VARCHAR(100),
  image VARCHAR(255),
  role_id INT NOT NULL,
  status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'approved',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (role_id) REFERENCES user_roles(id)
);

CREATE TABLE IF NOT EXISTS customers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  whatsapp_number VARCHAR(30) NOT NULL UNIQUE,
  email VARCHAR(150) DEFAULT NULL,
  image VARCHAR(255) DEFAULT NULL,
  password VARCHAR(255) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(120) NOT NULL UNIQUE,
  image VARCHAR(255),
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS subcategories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  category_id INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(120) NOT NULL UNIQUE,
  image VARCHAR(255),
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS products (
  id INT AUTO_INCREMENT PRIMARY KEY,
  category_id INT,
  subcategory_id INT,
  name VARCHAR(200) NOT NULL,
  slug VARCHAR(220) NOT NULL UNIQUE,
  product_code VARCHAR(50) DEFAULT NULL UNIQUE,
  description TEXT,
  purchase_price DECIMAL(10,2) NOT NULL DEFAULT 0,
  sale_price DECIMAL(10,2) NOT NULL,
  discount_percent DECIMAL(5,2) NOT NULL DEFAULT 0,
  discount_price DECIMAL(10,2) GENERATED ALWAYS AS (ROUND(sale_price - (sale_price * discount_percent / 100), 2)) STORED,
  stock INT NOT NULL DEFAULT 0,
  image VARCHAR(255),
  featured TINYINT(1) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
  FOREIGN KEY (subcategory_id) REFERENCES subcategories(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  customer_id INT NULL,
  total_amount DECIMAL(10,2) NOT NULL,
  status ENUM('pending', 'successful', 'return', 'cancelled') NOT NULL DEFAULT 'pending',
  payment_method VARCHAR(30) NOT NULL DEFAULT 'cod',
  shipping_name VARCHAR(100) NULL,
  shipping_phone VARCHAR(30) NULL,
  shipping_address VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS order_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  product_id INT,
  product_name VARCHAR(200) NOT NULL,
  product_code VARCHAR(50) DEFAULT NULL,
  price DECIMAL(10,2) NOT NULL,
  quantity INT NOT NULL,
  returned_quantity INT NOT NULL DEFAULT 0,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS wishlist_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  owner_type ENUM('customer', 'staff') NOT NULL,
  owner_id INT NOT NULL,
  product_id INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_wishlist (owner_type, owner_id, product_id),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS offers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  image VARCHAR(255) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS banners (
  id INT AUTO_INCREMENT PRIMARY KEY,
  image VARCHAR(255) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS blogs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  subject VARCHAR(200) NOT NULL,
  message TEXT NOT NULL,
  images JSON NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  identifier VARCHAR(150) NOT NULL,
  purpose VARCHAR(30) NOT NULL,
  code_hash VARCHAR(255) NOT NULL,
  payload TEXT NULL,
  attempts INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMP NOT NULL,
  verified_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_otp_identifier_purpose (identifier, purpose)
);

CREATE TABLE IF NOT EXISTS settings (
  id INT PRIMARY KEY DEFAULT 1,
  store_name VARCHAR(150) NOT NULL DEFAULT 'Soon',
  store_short_name VARCHAR(20) NOT NULL DEFAULT 'Soon',
  store_logo VARCHAR(255),
  store_icon VARCHAR(255),
  whatsapp_number VARCHAR(30),
  address VARCHAR(255),
  email VARCHAR(150),
  theme_color_light VARCHAR(7) NOT NULL DEFAULT '#000000',
  theme_color_dark VARCHAR(7) NOT NULL DEFAULT '#000000',
  wholesale_token VARCHAR(64) NULL,
  terms_content LONGTEXT,
  return_policy_content LONGTEXT,
  privacy_policy_content LONGTEXT,
  about_content LONGTEXT,
  emailjs_service_id VARCHAR(100),
  emailjs_public_key VARCHAR(150),
  emailjs_private_key VARCHAR(150),
  emailjs_reply_to VARCHAR(150),
  emailjs_template_otp VARCHAR(100),
  emailjs_template_notify VARCHAR(100),
  drive_client_id VARCHAR(255),
  drive_client_secret VARCHAR(255),
  drive_refresh_token TEXT,
  drive_folder_id VARCHAR(150),
  active_font VARCHAR(150) NOT NULL DEFAULT 'Archivo Narrow',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS fonts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL UNIQUE,
  family_param VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
