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
import { gunzipSync, gzipSync } from 'node:zlib';
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

/**
 * Parse the complete, well-formed HTTP/1.1 responses (chunked or sized) at the start of `buffer` and return
 * their decoded bodies. Parsing stops at the first incomplete, mis-framed or undecodable response, so a
 * response the defect cut off counts as unanswered instead of throwing from a socket handler.
 */
function responses(buffer: Buffer): string[] {
	const out: string[] = [];
	let offset = 0;
	for (;;) {
		const headEnd = buffer.indexOf('\r\n\r\n', offset);
		if (headEnd === -1) return out;
		const head = buffer.toString('latin1', offset, headEnd);
		const framed = /transfer-encoding: chunked/i.test(head) ? chunkedBody(buffer, headEnd + 4) : sizedBody(buffer, head, headEnd + 4);
		if (!framed) return out;
		try {
			out.push((/content-encoding: gzip/i.test(head) ? gunzipSync(framed.body) : framed.body).toString());
		} catch {
			return out;
		}
		offset = framed.end;
	}
}

/** A chunked body starting at `position`, or null when it is incomplete or a chunk is mis-framed. */
function chunkedBody(buffer: Buffer, position: number): { body: Buffer; end: number } | null {
	const chunks: Buffer[] = [];
	for (;;) {
		const lineEnd = buffer.indexOf('\r\n', position);
		if (lineEnd === -1) return null;
		const sizeLine = buffer.toString('latin1', position, lineEnd);
		if (!/^[0-9a-f]+$/i.test(sizeLine)) return null;
		const size = Number.parseInt(sizeLine, 16);
		const dataEnd = lineEnd + 2 + size;
		if (buffer.length < dataEnd + 2 || buffer.toString('latin1', dataEnd, dataEnd + 2) !== '\r\n') return null;
		if (size === 0) return { body: Buffer.concat(chunks), end: dataEnd + 2 };
		chunks.push(buffer.subarray(lineEnd + 2, dataEnd));
		position = dataEnd + 2;
	}
}

/** A Content-Length body starting at `position`, or null when it is incomplete or unsized. */
function sizedBody(buffer: Buffer, head: string, position: number): { body: Buffer; end: number } | null {
	const length = Number(/content-length: (\d+)/i.exec(head)?.[1]);
	if (!Number.isInteger(length) || buffer.length < position + length) return null;
	return { body: buffer.subarray(position, position + length), end: position + length };
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

	// The defect can also cut a response off mid-body and start the next one on the same socket. The parser
	// must count that as an unanswered pair, not throw from a socket handler (a CI flake: "incorrect header check").
	test('a cut-off or undecodable response ends the parse instead of throwing', () => {
		const gzipped = gzipSync(SCRIPT);
		const head = 'HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nTransfer-Encoding: chunked\r\n\r\n';
		const chunk = (bytes: Buffer) => Buffer.concat([Buffer.from(`${bytes.length.toString(16)}\r\n`, 'latin1'), bytes, Buffer.from('\r\n')]);
		const whole = Buffer.concat([Buffer.from(head, 'latin1'), chunk(gzipped), Buffer.from('0\r\n\r\n')]);
		const cutOff = Buffer.concat([Buffer.from(head, 'latin1'), chunk(gzipped.subarray(0, 100)), whole]);
		const notGzip = Buffer.concat([Buffer.from(head, 'latin1'), chunk(Buffer.from('plain text')), Buffer.from('0\r\n\r\n')]);
		expect(responses(whole)).toEqual([SCRIPT]);
		expect(responses(cutOff)).toEqual([]);
		expect(responses(notGzip)).toEqual([]);
		expect(responses(Buffer.concat([whole, notGzip, whole]))).toEqual([SCRIPT]);
	});

	test('the default version is the running Bun', () => {
		const installed: unknown[] = [];
		const server = { middlewares: { use: (fn: unknown) => installed.push(fn) } } as unknown as PreviewServer;
		(previewPipelineGuard().configurePreviewServer as (server: PreviewServer) => void)(server);
		expect(installed).toHaveLength(PIPELINE_REPLAY_DEFECT_BUNS.has(Bun.version) ? 1 : 0);
	});
});
