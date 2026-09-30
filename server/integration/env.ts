import { testDatabaseUrl } from "./guard";

process.env.DATABASE_URL = testDatabaseUrl();
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET ||= "integration-session-secret-0123456789abcdef";
