import { type ChildProcess, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ExporterAnswer, ExporterPhase, ExporterStart, ExporterState } from "../../shared/proton-export.ts";
import { ExportFolder } from "./files.ts";
import { Session } from "./session.ts";

/**
 * The container's one process: runs Proton's Export Tool for the ProtonImport Durable Object (worker/proton-import.ts),
 * the only thing that can reach this port, and hands it the exported files one by one.
 *
 * Nothing the tool prints is logged here: it includes the account's address and the human-check link, and container
 * output goes to Workers Logs. Its own log, with the account's encrypted keys, stays on this disk, which goes when the
 * container does.
 */

const TOOL = "/opt/proton-export/proton-mail-export-cli";
const ROOT = "/export";
const PORT = 8080;
/** Bodies here are a login and a password, or an answer. */
const MAX_BODY = 4096;
/** After SIGTERM (the container is being stopped), how long the tool gets to sign out of Proton. */
const SIGN_OUT_MS = 20_000;

const folder = new ExportFolder(ROOT);
let session: Session | null = null;
let child: ChildProcess | null = null;
let logged: ExporterPhase = "idle";

function start({ login, password }: ExporterStart): void {
	// stderr into stdout, so each error line comes before the prompt it explains.
	const tool = spawn("/bin/sh", ["-c", 'exec "$0" "$@" 2>&1', TOOL, "--operation", "backup", "--dir", ROOT], {
		env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", ET_USER_EMAIL: login, ET_TELEMETRY_OFF: "1" },
		stdio: ["pipe", "pipe", "ignore"],
	});
	const s = new Session(
		{
			write: (text) => tool.stdin?.write(text),
			interrupt: () => tool.kill("SIGINT"),
		},
		login,
		password,
	);
	// A write after the tool exited fails with EPIPE; its exit, reported below, is what counts.
	tool.stdin?.on("error", () => undefined);
	tool.stdout?.setEncoding("utf8");
	tool.stdout?.on("data", (text: string) => {
		s.feed(text);
		logPhase(s.phase);
	});
	// "close", not "exit": it comes once the tool's output has all been read, so "Export Finished" is in before it ends.
	tool.on("close", (code) => {
		s.exit(code ?? 1);
		logPhase(s.phase);
		child = null;
	});
	tool.on("error", (error) => {
		s.exit(1);
		logPhase(s.phase);
		console.error(JSON.stringify({ msg: "proton export: couldn't run the tool", error: error.message }));
	});
	session = s;
	child = tool;
	logPhase(s.phase);
}

function logPhase(phase: ExporterPhase): void {
	if (phase === logged) return;
	logged = phase;
	console.log(JSON.stringify({ msg: "proton export", phase }));
}

async function state(): Promise<ExporterState> {
	if (!session) return { phase: "idle", prompt: 0, error: null, verifyUrl: null, percent: 0, ready: 0, unexported: 0 };
	const s = session.state();
	return { ...s, ...(await folder.counts(s.phase === "exported" || s.phase === "failed" || s.phase === "stopped")) };
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? "/", "http://container");
	const path = url.pathname;
	const message = /^\/messages\/([^/]+)(?:\/(eml|metadata))?$/.exec(path);

	if (req.method === "GET" && path === "/state") return json(res, 200, await state());

	if (req.method === "POST" && path === "/start") {
		if (session) return json(res, 409, { error: "Already started" });
		const body = await readJson(req);
		if (!isStart(body)) return json(res, 400, { error: "Expected a login and a password" });
		start(body);
		return json(res, 202, await state());
	}

	if (req.method === "POST" && path === "/answer") {
		const body = await readJson(req);
		if (!isAnswer(body)) return json(res, 400, { error: "Expected an answer" });
		return session?.answer(body) ? json(res, 202, await state()) : json(res, 409, { error: "That isn't the question being asked" });
	}

	if (req.method === "POST" && path === "/stop") {
		session?.stop();
		return json(res, 202, await state());
	}

	if (req.method === "GET" && path === "/labels") return send(res, await folder.labels(), "application/json");

	if (req.method === "GET" && path === "/messages") {
		const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 1000);
		return json(res, 200, { ids: await folder.ready(limit) });
	}

	if (message?.[1]) {
		const id = decodeURIComponent(message[1]);
		if (req.method === "GET" && message[2]) return send(res, await folder.file(id, message[2] === "eml" ? "eml" : "metadata"), message[2] === "eml" ? "message/rfc822" : "application/json");
		if (req.method === "DELETE" && !message[2]) return (await folder.remove(id)) ? end(res, 204) : json(res, 404, { error: "Not found" });
	}

	return json(res, 404, { error: "Not found" });
}

function send(res: ServerResponse, file: { path: string; size: number } | null, type: string): void {
	if (!file) return json(res, 404, { error: "Not found" });
	res.writeHead(200, { "Content-Type": type, "Content-Length": file.size });
	// A file that can't be read after all fails this response, which the alarm tries again, rather than the process.
	createReadStream(file.path)
		.on("error", (error) => res.destroy(error))
		.pipe(res);
}

function json(res: ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body);
	res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
	res.end(text);
}

function end(res: ServerResponse, status: number): void {
	res.writeHead(status);
	res.end();
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		if (!Buffer.isBuffer(chunk)) continue;
		size += chunk.length;
		if (size > MAX_BODY) return null;
		chunks.push(chunk);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return null;
	}
}

function isStart(body: unknown): body is ExporterStart {
	return isRecord(body) && typeof body.login === "string" && body.login.length > 0 && typeof body.password === "string" && body.password.length > 0;
}

function isAnswer(body: unknown): body is ExporterAnswer {
	return isRecord(body) && typeof body.prompt === "number" && typeof body.value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

const server = createServer((req, res) => {
	route(req, res).catch((error: unknown) => {
		console.error(JSON.stringify({ msg: "proton export: request failed", path: req.url, error: String(error) }));
		if (!res.headersSent) json(res, 500, { error: "Internal error" });
		else res.destroy();
	});
});
server.listen(PORT);

// Cloudflare stops a container with SIGTERM: let the tool sign out of Proton first.
process.on("SIGTERM", () => {
	const running = child;
	if (!running) process.exit(0);
	session?.stop();
	running.on("exit", () => process.exit(0));
	setTimeout(() => process.exit(0), SIGN_OUT_MS).unref();
});
