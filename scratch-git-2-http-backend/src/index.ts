import { spawn } from "child_process";
import cors from "cors";
import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
const app = express();
const port = process.env.GIT_BACKEND_PORT || 3101;

app.use(cors());
// IMPORTANT: Do NOT use express.json() or body-parser here.
// It consumes streams that need to go to git-http-backend.

const buildVersion = process.env.BUILD_VERSION || "0.0.0-local";
const reposDir = process.env.GIT_REPOS_DIR || "repos";

// Root endpoint
app.get("/", (_, res) => {
  const absoluteReposDir = path.isAbsolute(reposDir)
    ? reposDir
    : path.join(process.cwd(), reposDir);
  const repoCount = fs.existsSync(absoluteReposDir)
    ? fs.readdirSync(absoluteReposDir).filter((name) => name.endsWith(".git"))
        .length
    : 0;
  res.json({
    service: "git-http-backend",
    build_version: buildVersion,
    reposDir: absoluteReposDir,
    repoCount,
    timestamp: new Date().toISOString(),
  });
});

// Health check
app.get("/health", (_, res) =>
  res.json({
    status: "alive",
    service: "git-http-backend",
    build_version: buildVersion,
    reposDir,
    reposDirExists: fs.existsSync(reposDir),
    timestamp: new Date().toISOString(),
  }),
);

// Logging middleware
app.use((req, res, next) => {
  console.log(`[GIT] ${req.method} ${req.path}`);
  next();
});

// ==========================================
// Git Smart HTTP Backend (Standard Git Client)
// ==========================================
// Matches /:repo.git/info/refs, /:repo.git/git-upload-pack, etc.
app.all("/:repoId.git/*", (req, res) => {
  const repoId = req.params.repoId;
  const absoluteReposDir = path.isAbsolute(reposDir)
    ? reposDir
    : path.join(process.cwd(), reposDir);
  const repoPath = path.join(absoluteReposDir, `${repoId}.git`);

  // Check if repo directory exists before spawning git
  if (!fs.existsSync(repoPath)) {
    console.error(`[GIT] Repository not found: ${repoPath}`);
    res.status(404).send(`Repository not found: ${repoId}`);
    return;
  }

  // Check if it's a valid git repo (has HEAD file)
  const headPath = path.join(repoPath, "HEAD");
  if (!fs.existsSync(headPath)) {
    console.error(`[GIT] Invalid git repository (no HEAD): ${repoPath}`);
    res.status(500).send(`Invalid git repository: ${repoId}`);
    return;
  }

  console.log(
    `[GIT] Proxying to repo: ${repoPath}, GIT_PROJECT_ROOT: ${path.dirname(repoPath)}, PATH_INFO: ${req.path}`,
  );

  // env vars for git http-backend (CGI protocol)
  const env = Object.assign({}, process.env, {
    GIT_PROJECT_ROOT: path.dirname(repoPath), // Parent dir of repos
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: req.path, // e.g. /myrepo.git/info/refs
    REMOTE_USER: "scratch-user", // Mock auth user
    QUERY_STRING: req.url.split("?")[1] || "",
    REQUEST_METHOD: req.method,
    CONTENT_TYPE: req.headers["content-type"],
    CONTENT_LENGTH: req.headers["content-length"] || "",
  });

  // Spawn git http-backend
  const gitProc = spawn("git", ["http-backend"], { env });

  // Pipe request body to git process stdin
  req.pipe(gitProc.stdin);

  // Pipe outputs with CGI header parsing
  let headersSent = false;
  let buffer = Buffer.alloc(0);
  let stderrBuffer = "";

  gitProc.stdout.on("data", (chunk) => {
    if (headersSent) {
      res.write(chunk);
      return;
    }

    buffer = Buffer.concat([buffer, chunk]);

    // Look for double newline indicating end of headers
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd !== -1) {
      const headerPart = buffer.slice(0, headerEnd).toString("utf-8");
      const bodyPart = buffer.slice(headerEnd + 4);

      // Parse and set headers
      headerPart.split("\r\n").forEach((line) => {
        const [key, value] = line.split(": ");
        if (key && value) {
          res.setHeader(key, value);
        }
      });

      headersSent = true;
      res.write(bodyPart);
    }
  });

  gitProc.stderr.on("data", (data: Buffer) => {
    stderrBuffer += data.toString();
    console.error(`[GIT] stderr for ${repoId}: ${data.toString()}`);
  });

  gitProc.on("exit", (code) => {
    if (code !== 0) {
      console.error(
        `[GIT] git http-backend exited with code ${code} for repo ${repoId}, path: ${req.path}, stderr: ${stderrBuffer}`,
      );
      if (!res.headersSent) {
        res
          .status(500)
          .send(`Git backend error (code ${code}): ${stderrBuffer}`);
      }
    } else {
      res.end();
    }
  });
});

app.listen(port, () => {
  console.log(
    `Scratch Git HTTP Server listening on port ${port} (env: ${process.env.NODE_ENV || "development"})`,
  );
});
