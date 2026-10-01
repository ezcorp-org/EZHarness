/**
 * The preview pipeline guard against the real vite preview server, under the Bun running this test.
 * A child process serves a temporary build (one large script) with `vite preview`; the test sends two
 * pipelined gzip requests in one packet on fresh connections, which is what a browser does to a busy
 * keep-alive connection. The child is separate because the defect kills the process that hosts it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { Plugin, PreviewServer } from 'vite';
import { PIPELINE_REPLAY_DEFECT_BUNS, previewPipelineGuard } from './preview-pipeline-guard';

const WEB_ROOT = resolve(import.meta.dir, '../../..');
const GUARD = join(import.meta.dir, 'preview-pipeline-guard.ts');
const SCRIPT = `${Array.from({ length: 6000 }, (_, i) => `console.log(${i});`).join('\n')}\n`;
let root: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'preview-pipeline-guard-'));
	mkdirSync(join(root, 'dist'));
	writeFileSync(join(root, 'dist', 'index.html'), '<!doctype html><title>t</title>');
	writeFileSync(join(root, 'dist', 'big.js'), SCRIPT);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

type Served = { outcome: 'answered' | 'crashed' | 'stalled'; bodies: string[]; stderr: string };

/** Parse complete HTTP/1.1 responses (chunked or sized) and return their decoded bodies. */
function responses(buffer: Buffer): string[] {
	const out: string[] = [];
	let offset = 0;
	for (;;) {
		const headEnd = buffer.indexOf('\r\n\r\n', offset);
		if (headEnd === -1) return out;
		const head = buffer.toString('latin1', offset, headEnd);
		let position = headEnd + 4;
		let body: Buffer;
		if (/transfer-encoding: chunked/i.test(head)) {
			const chunks: Buffer[] = [];
			for (;;) {
				const lineEnd = buffer.indexOf('\r\n', position);
				if (lineEnd === -1) return out;
				const size = Number.parseInt(buffer.toString('latin1', position, lineEnd), 16);
				if (size === 0) {
					position = lineEnd + 4;
					break;
				}
				if (buffer.length < lineEnd + 2 + size + 2) return out;
				chunks.push(buffer.subarray(lineEnd + 2, lineEnd + 2 + size));
				position = lineEnd + 2 + size + 2;
			}
			body = Buffer.concat(chunks);
		} else {
			const length = Number(/content-length: (\d+)/i.exec(head)?.[1]);
			if (buffer.length < position + length) return out;
			body = buffer.subarray(position, position + length);
			position += length;
		}
		out.push((/content-encoding: gzip/i.test(head) ? gunzipSync(body) : body).toString());
		offset = position;
	}
}

/** Two pipelined GETs in one packet; resolves with the decoded bodies, or fewer when the peer stops. */
function pipelined(port: number): Promise<string[]> {
	return new Promise((resolveBodies) => {
		let buffer = Buffer.alloc(0);
		const socket = connect(port, '127.0.0.1', () => {
			const request = `GET /big.js HTTP/1.1\r\nHost: localhost:${port}\r\nAccept-Encoding: gzip\r\n\r\n`;
			socket.write(request + request);
		});
		const settle = () => {
			clearTimeout(timer);
			socket.destroy();
			resolveBodies(responses(buffer));
		};
		const timer = setTimeout(settle, 5000);
		socket.on('data', (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			if (responses(buffer).length >= 2) settle();
		});
		socket.on('error', settle);
		socket.on('close', settle);
	});
}

/** Serve `root` with vite preview in a child Bun (guarded or not) and send up to `rounds` pipelined pairs. */
async function serve(guarded: boolean, rounds: number): Promise<Served> {
	const program = `
		const { preview } = await import(${JSON.stringify(join(WEB_ROOT, 'node_modules/vite/dist/node/index.js'))});
		const { previewPipelineGuard } = await import(${JSON.stringify(GUARD)});
		const server = await preview({
			root: ${JSON.stringify(root)}, configFile: false, logLevel: 'silent',
			plugins: ${guarded ? '[previewPipelineGuard()]' : '[]'},
			preview: { port: 0, host: '127.0.0.1' },
		});
		console.log('PORT ' + server.httpServer.address().port);
	`;
	const child = Bun.spawn([process.execPath, '-e', program], { cwd: WEB_ROOT, stdout: 'pipe', stderr: 'pipe' });
	const stderrText = new Response(child.stderr).text();
	const reader = child.stdout.getReader();
	let announced = '';
	while (!/PORT \d+/.test(announced)) {
		const { value, done } = await reader.read();
		if (done) throw new Error(`vite preview did not start: ${await stderrText}`);
		announced += new TextDecoder().decode(value);
	}
	const port = Number(/PORT (\d+)/.exec(announced)?.[1]);
	let outcome: Served['outcome'] = 'answered';
	const bodies: string[] = [];
	for (let round = 0; round < rounds && outcome === 'answered'; round++) {
		const got = await pipelined(port);
		bodies.push(...got);
		if (got.length < 2) outcome = child.exitCode === null && !child.killed ? await exitedSoon(child) : 'crashed';
	}
	child.kill();
	await child.exited;
	return { outcome, bodies, stderr: await stderrText };
}

async function exitedSoon(child: Bun.Subprocess): Promise<Served['outcome']> {
	const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(1000).then(() => false)]);
	return exited ? 'crashed' : 'stalled';
}

describe('previewPipelineGuard', () => {
	test('with the guard, pipelined requests are all answered with the file, on this Bun', async () => {
		const served = await serve(true, 5);
		expect(served.stderr).not.toContain('ERR_STREAM_WRITE_AFTER_END');
		expect(served.outcome).toBe('answered');
		expect(served.bodies).toEqual(Array.from({ length: 10 }, () => SCRIPT));
	}, 60_000);

	// The defect shows two ways on 1.4.2: the replay throws and the process exits (ERR_STREAM_WRITE_AFTER_END), or
	// the queued response never finishes. Either is a pipelined pair left unanswered.
	test("without it, this Bun leaves a pipelined pair unanswered exactly when the guard's release list names it", async () => {
		const served = await serve(false, 10);
		const unanswered = served.outcome !== 'answered';
		expect({ bun: Bun.version, unanswered }, `${served.outcome}: ${served.stderr}`).toEqual({
			bun: Bun.version,
			unanswered: PIPELINE_REPLAY_DEFECT_BUNS.has(Bun.version),
		});
	}, 60_000);

	test('it installs its middleware only on an affected Bun, and the middleware drops Accept-Encoding', () => {
		const installed: Array<(req: { headers: Record<string, string> }, res: unknown, next: () => void) => void> = [];
		const server = { middlewares: { use: (fn: (typeof installed)[number]) => installed.push(fn) } } as unknown as PreviewServer;
		const hook = (plugin: Plugin) => plugin.configurePreviewServer as (server: PreviewServer) => void;
		hook(previewPipelineGuard('1.3.14'))(server);
		hook(previewPipelineGuard('1.4.3'))(server);
		hook(previewPipelineGuard(''))(server);
		expect(installed).toHaveLength(0);
		hook(previewPipelineGuard('1.4.2'))(server);
		expect(installed).toHaveLength(1);
		const req: { headers: Record<string, string> } = { headers: { 'accept-encoding': 'gzip, br', host: 'x' } };
		let nextCalls = 0;
		installed[0](req, {}, () => nextCalls++);
		expect(req.headers).toEqual({ host: 'x' });
		expect(nextCalls).toBe(1);
	});

	test('the default version is the running Bun', () => {
		const installed: unknown[] = [];
		const server = { middlewares: { use: (fn: unknown) => installed.push(fn) } } as unknown as PreviewServer;
		(previewPipelineGuard().configurePreviewServer as (server: PreviewServer) => void)(server);
		expect(installed).toHaveLength(PIPELINE_REPLAY_DEFECT_BUNS.has(Bun.version) ? 1 : 0);
	});
});
