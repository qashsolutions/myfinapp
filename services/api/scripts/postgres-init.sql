-- Runs once when the docker-compose Postgres volume is first created.
-- A second database so `uv run pytest` can run against the compose stack
-- without touching dev data (tests refuse any database not ending in _test).
CREATE DATABASE stackd_test OWNER stackd;
