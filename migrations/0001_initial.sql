CREATE TABLE IF NOT EXISTS records (
  namespace  TEXT    NOT NULL,
  collection TEXT    NOT NULL,
  id         TEXT    NOT NULL,
  data       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version    TEXT,
  PRIMARY KEY (namespace, collection, id)
);
