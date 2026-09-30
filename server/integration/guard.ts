/**
 * Integration tests drop and recreate every table in the target database. They only run
 * against an explicit TEST_DATABASE_URL whose database name ends in `_it` or `_test`, on a
 * local host unless ALLOW_REMOTE_TEST_DB=1 (isolated staging only). DATABASE_URL is ignored.
 */
export function testDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) throw new Error("TEST_DATABASE_URL is required for integration tests (pnpm test:db)");
  const url = new URL(raw);
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!/(_it|_test)$/.test(name)) {
    throw new Error(`Refusing database "${name}": integration databases must end in _it or _test`);
  }
  const local = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if (!local && process.env.ALLOW_REMOTE_TEST_DB !== "1") {
    throw new Error(`Refusing non-local host ${url.hostname}; set ALLOW_REMOTE_TEST_DB=1 only for an isolated staging database`);
  }
  return raw;
}
