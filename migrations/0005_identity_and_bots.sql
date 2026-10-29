-- Network (autonomous system number) a visit came from, as Cloudflare reports it. Helps spot bot farms.
ALTER TABLE sessions ADD COLUMN asn INTEGER;

-- When a visitor identify()s as a user_id another visitor already has, its history moves to the oldest
-- visitor of that user. Events sent later with the old visitor id are recorded under the kept one.
CREATE TABLE visitor_aliases (
  site_id TEXT NOT NULL,
  alias_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (site_id, alias_id)
);

CREATE INDEX visitors_user ON visitors (site_id, user_id);
