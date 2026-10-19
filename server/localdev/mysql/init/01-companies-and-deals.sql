-- Seed for the local MySQL/MariaDB in server/localdev/docker-compose.mysql.yml: `companies` and `deals`, linked by
-- deals.company_id → companies.id. For manual testing and /connector-build-execute; integration specs create their
-- own hermetic scratch_mysql_it_* tables and never depend on this data.
-- Runs automatically when a container starts with an empty volume (first `up`, or after `down -v`).
-- Re-running it by hand (from the repo root) drops and recreates both tables, resetting them to this data:
--   docker compose -f server/localdev/docker-compose.mysql.yml exec -T mysql mysql -utest -ptest test_db < server/localdev/mysql/init/01-companies-and-deals.sql
--   docker compose -f server/localdev/docker-compose.mysql.yml exec -T mariadb mariadb -utest -ptest test_db < server/localdev/mysql/init/01-companies-and-deals.sql
-- Between them the columns cover the main MySQL types: INT (incl. UNSIGNED), BIGINT, DECIMAL, DOUBLE, CHAR, VARCHAR,
-- TEXT, ENUM, SET, BOOLEAN, JSON, DATE, DATETIME, TIMESTAMP and YEAR.

SET NAMES utf8mb4;

DROP TABLE IF EXISTS deals;
DROP TABLE IF EXISTS companies;

CREATE TABLE companies (
  id INT AUTO_INCREMENT PRIMARY KEY,
  public_uuid CHAR(36) NOT NULL DEFAULT (UUID()) UNIQUE,
  name VARCHAR(255) NOT NULL,
  domain VARCHAR(255) NULL UNIQUE,
  industry VARCHAR(100) NULL,
  tags SET('customer', 'prospect', 'partner', 'churned', 'enterprise') NULL,
  employee_count INT UNSIGNED NULL,
  annual_revenue DECIMAL(15, 2) NULL,
  is_public BOOLEAN NOT NULL DEFAULT FALSE,
  founded_year YEAR NULL,
  hq_country CHAR(2) NULL,
  description TEXT NULL,
  address JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE deals (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NULL,
  name VARCHAR(255) NOT NULL,
  stage ENUM('lead', 'qualified', 'proposal', 'negotiation', 'closed_won', 'closed_lost') NOT NULL DEFAULT 'lead',
  amount DECIMAL(15, 2) NULL,
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  win_probability DOUBLE NULL,
  expected_close_date DATE NULL,
  closed_at DATETIME NULL,
  external_crm_id BIGINT NULL UNIQUE,
  owner_email VARCHAR(255) NULL,
  notes TEXT NULL,
  custom_fields JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_deals_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE SET NULL
);

INSERT INTO companies
  (id, name, domain, industry, tags, employee_count, annual_revenue, is_public, founded_year, hq_country, description,
   address, created_at)
VALUES
  (1, 'Acme Corporation', 'acme.example', 'Manufacturing', 'customer,enterprise', 12000, 850000000.00, TRUE, 1948, 'US',
    'Rockets, anvils and giant magnets for the discerning coyote.',
    '{"street": "1 Mesa Rd", "city": "Phoenix", "region": "AZ", "postal_code": "85001", "country": "US"}',
    '2025-01-15 09:30:00'),
  (2, 'Globex Corporation', 'globex.example', 'Energy', 'customer', 4800, 210500000.00, FALSE, 1989, 'US',
    'Industrial automation and energy systems.',
    '{"street": "500 Cypress Creek Pkwy", "city": "Springfield", "region": "OR", "postal_code": "97477", "country": "US"}',
    '2025-02-03 14:05:00'),
  (3, 'Initech', 'initech.example', 'Software', 'prospect', 850, 48000000.00, FALSE, 1994, 'US',
    'Banking back-office software. Mind the new cover sheets on the TPS reports.',
    '{"street": "100 Research Blvd", "city": "Austin", "region": "TX", "postal_code": "78759", "country": "US"}',
    '2025-03-21 11:00:00'),
  (4, 'Hooli', 'hooli.example', 'Software', 'prospect,enterprise', 32000, 2500000000.00, TRUE, 1998, 'US',
    'Consumer tech and cloud infrastructure.',
    '{"street": "2624 Mill St", "city": "Palo Alto", "region": "CA", "postal_code": "94301", "country": "US"}',
    '2025-05-10 16:45:00'),
  (5, 'Umbrella Corporation', 'umbrella.example', 'Pharmaceuticals', 'churned', 45000, 1200000000.00, TRUE, 1968, 'GB',
    'Pharmaceuticals and biotech research.',
    '{"street": "12 Raccoon Way", "city": "London", "postal_code": "EC1A 1BB", "country": "GB"}',
    '2025-06-02 08:20:00'),
  (6, 'Wayne Enterprises', 'wayne.example', 'Conglomerate', 'customer,partner,enterprise', 90000, 31000000000.00, TRUE,
    1939, 'US', 'Aerospace, shipping and applied sciences.',
    '{"street": "1007 Mountain Dr", "city": "Gotham", "region": "NJ", "postal_code": "07001", "country": "US"}',
    '2025-08-19 13:10:00'),
  -- Edge cases: umlauts, emoji and an embedded newline, an empty SET, YEAR's minimum (1901), a CJK name with every
  -- optional column NULL, and an apostrophe.
  (7, 'Kaffeerösterei Müller & Söhne GmbH', 'mueller-kaffee.example', 'Food & Beverage', '', 42, 3850000.75, FALSE, 1901,
    'DE', 'Specialty coffee roaster ☕\nBerlin · München · Zürich',
    '{"street": "Königstraße 12", "city": "Berlin", "postal_code": "10178", "country": "DE", "phones": ["+49 30 1234567", "+49 30 7654321"]}',
    '2025-11-04 10:00:00'),
  (8, 'ナカトミ商事株式会社', NULL, NULL, NULL, NULL, NULL, DEFAULT, NULL, NULL, NULL, NULL, DEFAULT),
  (9, 'Bluth''s Frozen Banana Stand', 'bluth.example', 'Retail', 'prospect', 3, 12000.50, FALSE, 1953, 'US',
    'Frozen bananas since 1953.',
    '{"street": "1 Harbor Walk", "city": "Newport Beach", "region": "CA", "postal_code": "92661", "country": "US"}',
    '2026-04-01 12:00:00');

INSERT INTO deals
  (id, company_id, name, stage, amount, currency, win_probability, expected_close_date, closed_at, external_crm_id,
   owner_email, notes, custom_fields, created_at)
VALUES
  (1, 1, 'Anvil line expansion', 'negotiation', 250000.00, 'USD', 0.75, '2026-10-31', NULL, 480000000001,
    'alex.rivera@example.com', 'Procurement wants net-60 terms.',
    '{"lead_source": "trade_show", "competitors": ["Ajax Tools", "Zenith Forge"], "decision_makers": 3}',
    '2026-05-04 10:12:00'),
  (2, 1, 'Rocket skates renewal', 'closed_won', 48000.00, 'USD', 1, '2026-03-31', '2026-03-28 17:42:10', 480000000002,
    'alex.rivera@example.com', NULL, '{"lead_source": "renewal"}', '2026-01-10 09:00:00'),
  (3, 2, 'Plant automation rollout', 'proposal', 1250000.00, 'USD', 0.4, '2026-12-15', NULL, NULL,
    'sam.chen@example.com', 'Needs a security review before legal.',
    '{"lead_source": "referral", "competitors": [], "requires_security_review": true}', '2026-06-18 15:30:00'),
  (4, 3, 'TPS report tooling', 'qualified', 36000.00, 'USD', 0.25, '2027-01-31', NULL, NULL,
    'priya.patel@example.com', NULL, NULL, '2026-07-22 11:45:00'),
  (5, 3, 'Printer fleet replacement', 'closed_lost', 8900.00, 'USD', 0, '2026-06-30', '2026-06-12 10:15:00', NULL,
    'priya.patel@example.com', 'Lost on price.\nRevisit next fiscal year.', NULL, '2026-04-02 13:00:00'),
  (6, 4, 'Nucleus compression licensing', 'lead', NULL, 'USD', NULL, NULL, NULL, NULL,
    'sam.chen@example.com', NULL, NULL, '2026-09-01 09:15:00'),
  (7, 5, 'Lab supplies contract', 'closed_won', 780000.00, 'USD', 1, '2025-12-31', '2025-12-19 16:05:00', 480000000007,
    'alex.rivera@example.com', NULL, NULL, '2025-08-11 10:00:00'),
  (8, 6, 'Applied Sciences R&D partnership', 'negotiation', 4750000.00, 'USD', 0.6, '2026-11-30', NULL, NULL,
    'sam.chen@example.com', NULL, '{"lead_source": "partner", "nda": {"signed": true, "signed_on": "2026-05-02"}}',
    '2026-03-15 14:00:00'),
  -- Edge cases: EUR/JPY amounts, CJK text and emoji, external_crm_id = 2^53 + 1 (a JS number can't hold it exactly),
  -- a zero amount, an apostrophe, and a deal with no company.
  (9, 7, 'Espresso machines for 3 cafés', 'proposal', 18500.00, 'EUR', 0.5, '2026-11-15', NULL, NULL,
    'priya.patel@example.com', 'Wants a demo in München; bring oat milk 🥛',
    '{"lead_source": "website", "locations": ["Berlin", "München", "Zürich"]}', '2026-08-03 08:30:00'),
  (10, 8, 'ロボットアーム導入', 'qualified', 12000000.00, 'JPY', 0.3, '2027-03-31', NULL, 9007199254740993,
    'sam.chen@example.com', NULL, '{"lead_source": "partner", "language": "ja"}', DEFAULT),
  (11, 9, 'Banana stand franchise pilot', 'closed_won', 0.00, 'USD', 1, '2026-05-31', '2026-05-20 12:00:00', NULL,
    'alex.rivera@example.com', 'Free pilot. There''s always money in the banana stand. 🍌', NULL, '2026-04-15 12:00:00'),
  (12, NULL, 'Unassigned inbound lead', 'lead', NULL, 'USD', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    '2026-09-28 22:47:00');
