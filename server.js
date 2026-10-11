const { createServer } = require("http");
const { parse } = require("url");
const next = require("next");
const fs = require("fs");
const path = require("path");

const port = parseInt(process.env.PORT || "3000", 10);
const app = next({ dev: false, dir: __dirname });
const handle = app.getRequestHandler();

process.on("uncaughtException", (err) => {
  const msg = `[${new Date().toISOString()}] UncaughtException: ${err?.stack || err}\n`;
  console.error(msg);
  try {
    fs.appendFileSync(path.join(__dirname, "server_error.log"), msg);
  } catch {}
});

process.on("unhandledRejection", (err) => {
  const msg = `[${new Date().toISOString()}] UnhandledRejection: ${err?.stack || err}\n`;
  console.error(msg);
  try {
    fs.appendFileSync(path.join(__dirname, "server_error.log"), msg);
  } catch {}
});

app.prepare().then(() => {
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url, true);
    handle(req, res, parsedUrl);
  });

  server.listen(port, "0.0.0.0", (err) => {
    if (err) throw err;
    console.log(`> UltronOrbUI ready on http://localhost:${port}`);
  });
}).catch((err) => {
  console.error("Failed to prepare app:", err);
  process.exit(1);
});
