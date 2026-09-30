import express from "express";
import { createServer } from "http";
import path from "path";
import { hostRedirect } from "./_core/hostRedirect";
import { mountSpa, securityHeaders } from "./_core/spa";

// Static web service for resulio.co. The API, auth callbacks and database live on the separate API service.
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(hostRedirect);
app.use(securityHeaders);
app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});
mountSpa(app, path.resolve(import.meta.dirname, "public"));

const port = Number(process.env.PORT || "3000");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
const server = createServer(app);
server.on("error", (error) => {
  console.error("Server failed:", error.message);
  process.exit(1);
});
server.listen(port, "0.0.0.0", () => console.log(`Frontend listening on port ${port}`));
