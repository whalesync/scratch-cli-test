import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { ScratchCli } from "../src/cli";
import {
  deleteWorkspace,
  TEST_CONNECTOR_SERVICE,
  uniqueName,
} from "../src/helpers";
import { setupTestTable, teardownTestTable } from "../src/postgres";

const cli = new ScratchCli();
const postgresUrl = process.env.DATABASE_URL;
const describeIfPostgres = postgresUrl ? describe : describe.skip;

const apiKey = process.env.SCRATCH_API_KEY;

/**
 * Valid git-upload-pack POST body: want HEAD, flush, then done — matches
 * scratch-git-2 `upload_pack_succeeds_with_valid_pkt_line_body`.
 */
function buildUploadPackRequestBody(headOid: string): string {
  const wantLine = `want ${headOid} multi_ack_detailed side-band-64k ofs-delta agent=git/test\n`;
  const wantBytes = Buffer.byteLength(wantLine, "utf8");
  const pktLen = wantBytes + 4;
  const wantPkt = pktLen.toString(16).padStart(4, "0") + wantLine;
  return `${wantPkt}00000009done\n`;
}

function resolveHeadOid(gitUrl: string, token: string): string {
  const out = execFileSync(
    "git",
    [
      "-c",
      `http.extraHeader=Authorization: API-Token ${token}`,
      "ls-remote",
      gitUrl,
      "HEAD",
    ],
    { encoding: "utf8" },
  );
  const line = out.trim().split("\n")[0] ?? "";
  const hash = line.split(/\t/)[0]?.trim() ?? "";
  if (!/^[0-9a-f]{40}$/.test(hash)) {
    throw new Error(`Unexpected ls-remote output:\n${out}`);
  }
  return hash;
}

function uploadPackPostUrl(gitUrl: string): string {
  return gitUrl.endsWith("/")
    ? `${gitUrl}git-upload-pack`
    : `${gitUrl}/git-upload-pack`;
}

describeIfPostgres(
  "Git HTTP proxy — POST git-upload-pack (raw vs gzip)",
  () => {
    let workspaceId: string;
    let gitUrl: string;
    let workspaceDir: string;

    beforeAll(async () => {
      if (!apiKey) {
        throw new Error("SCRATCH_API_KEY is required");
      }

      await setupTestTable();

      const ws = cli.json<{ id: string }>([
        "workspaces",
        "create",
        uniqueName("git-proxy-up"),
      ]);
      workspaceId = ws.id;

      cli.json<{ id: string }>([
        "connections",
        "--workspace",
        workspaceId,
        "add",
        "--service",
        TEST_CONNECTOR_SERVICE,
        "--param",
        `connectionString=${postgresUrl}`,
      ]);

      const parentDir = path.join(cli.home, "test-git-proxy-upload-pack");
      fs.mkdirSync(parentDir, { recursive: true });
      const initResult = cli.json<{ directory: string }>(
        ["workspaces", "init", workspaceId],
        {
          cwd: parentDir,
        },
      );
      workspaceDir = path.join(parentDir, initResult.directory);

      const show = cli.json<{
        connectorAccounts?: Array<{ gitUrl: string }>;
      }>(["workspaces", "show", workspaceId]);
      const ca = show.connectorAccounts?.[0];
      if (!ca?.gitUrl) {
        throw new Error("Expected connector gitUrl from workspaces show");
      }
      gitUrl = ca.gitUrl;
    });

    afterAll(async () => {
      if (workspaceId) deleteWorkspace(cli, workspaceId);
      if (workspaceDir) {
        try {
          fs.rmSync(workspaceDir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
      await teardownTestTable();
    });

    it("succeeds with a raw pkt-line body through Nest → scratch-git-2", async () => {
      const headOid = resolveHeadOid(gitUrl, apiKey!);
      const requestBody = buildUploadPackRequestBody(headOid);
      const postUrl = uploadPackPostUrl(gitUrl);

      const res = await fetch(postUrl, {
        method: "POST",
        headers: {
          Authorization: `API-Token ${apiKey}`,
          "Content-Type": "application/x-git-upload-pack-request",
        },
        body: requestBody,
      });

      const body = Buffer.from(await res.arrayBuffer());
      expect(res.status).toBe(200);
      expect(body.length).toBeGreaterThan(0);
    });

    it("succeeds with a gzip-compressed body through Nest → scratch-git-2", async () => {
      const headOid = resolveHeadOid(gitUrl, apiKey!);
      const requestBody = buildUploadPackRequestBody(headOid);
      const compressed = gzipSync(Buffer.from(requestBody, "utf8"));
      expect(compressed.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))).toBe(
        true,
      );

      const postUrl = uploadPackPostUrl(gitUrl);

      const res = await fetch(postUrl, {
        method: "POST",
        headers: {
          Authorization: `API-Token ${apiKey}`,
          "Content-Type": "application/x-git-upload-pack-request",
          "Content-Encoding": "gzip",
        },
        body: compressed,
      });

      const body = Buffer.from(await res.arrayBuffer());
      expect(res.status).toBe(200);
      expect(body.length).toBeGreaterThan(0);
    });
  },
);
