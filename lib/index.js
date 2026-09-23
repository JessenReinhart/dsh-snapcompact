import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import zlib from "node:zlib";
import { Service } from "@deepseek-ai/cordis";
import {
	CompactionId,
	ManualCompactionError,
	compactCheckpointSource,
	toolPairingBalancedAfter,
	toolPairingBalancedBefore
} from "@deepseek-ai/dsh-compaction";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionSeq } from "@deepseek-ai/dsh-session";

const require = createRequire(import.meta.url);

// ============================================================================
// Native Addon Loader & Fallback
// ============================================================================

let cachedNatives = null;

function loadNatives() {
	if (cachedNatives !== null) return cachedNatives;

	const candidates = [
		process.env.PI_NATIVES_PATH,
		"C:\\Users\\LGSM228\\.omp\\natives\\18.2.0\\pi_natives.win32-x64-baseline.node",
		"C:\\Users\\LGSM228\\.bun\\install\\cache\\@oh-my-pi\\pi-natives-win32-x64@18.1.22@@@1\\pi_natives.win32-x64-baseline.node"
	].filter(Boolean);

	for (const candidatePath of candidates) {
		try {
			if (fs.existsSync(candidatePath)) {
				const mod = require(candidatePath);
				if (typeof mod.renderSnapcompactPng === "function") {
					cachedNatives = mod;
					return mod;
				}
			}
		} catch {}
	}

	return null;
}

/** Pure-JS minimal PNG rasterizer fallback when native addon is unavailable */
function createFallbackPng(text, width = 1568, height = 1568) {
	// Simple 8-bit grayscale PNG
	const rowBytes = width + 1; // 1 filter byte + pixel bytes
	const rawData = Buffer.alloc(rowBytes * height, 0xff); // white background
	for (let y = 0; y < height; y++) {
		rawData[y * rowBytes] = 0; // Filter: None
	}

	const deflated = zlib.deflateSync(rawData);

	function crc32(buf) {
		let c = 0xffffffff;
		for (let i = 0; i < buf.length; i++) {
			c ^= buf[i];
			for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
		}
		return (c ^ 0xffffffff) >>> 0;
	}

	function makeChunk(type, data) {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length, 0);
		const typeBuf = Buffer.from(type, "ascii");
		const crcBuf = Buffer.alloc(4);
		crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
		return Buffer.concat([len, typeBuf, data, crcBuf]);
	}

	const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // Bit depth
	ihdr[9] = 0; // Grayscale
	ihdr[10] = 0; // Compression
	ihdr[11] = 0; // Filter
	ihdr[12] = 0; // Interlace

	const chunks = [
		header,
		makeChunk("IHDR", ihdr),
		makeChunk("IDAT", deflated),
		makeChunk("IEND", Buffer.alloc(0))
	];

	return Buffer.concat(chunks).toString("base64");
}

export async function renderPng(text, options = {}) {
	const natives = loadNatives();
	const size = options.size || options.frameSize || 1568;
	if (natives && typeof natives.renderSnapcompactPng === "function") {
		return natives.renderSnapcompactPng(text, {
			size,
			font: options.font || "8x13",
			cellWidth: options.cellWidth || 11,
			cellHeight: options.cellHeight || 16,
			stretch: options.stretch,
			variant: options.variant || "bw",
			lineRepeat: options.lineRepeat || 1,
			columns: options.columns
		});
	}
	return createFallbackPng(text, size, size);
}

// ============================================================================
// Constants & Markers
// ============================================================================

export const DIM_ON = "\u000e";
export const DIM_OFF = "\u000f";
export const NEWLINE_GLYPH = "\u2588";

const DIM_MARKERS = /[\u000e\u000f]/g;
const ANSI_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]/g;
const DATA_URL_RE = /data:[a-z0-9/+-]+;base64,[a-z0-9+/=\s]+/gi;

const STOPWORDS = new Set(
	(
		"the a an and or of to in on at as is are was were be been by for with that this it its from had has have not but " +
		"he she his her they their them which also who whom when where while will would could should there then than " +
		"into over under about after before between during each such these those some most more other only same so"
	).split(" ")
);

const EMOJI_FOLD = {
	"✅": "[OK]",
	"☑": "[OK]",
	"✔": "[OK]",
	"❌": "[FAIL]",
	"❎": "[FAIL]",
	"✖": "[FAIL]",
	"⚠": "[WARN]",
	"🚨": "[ALERT]",
	"ℹ": "[INFO]",
	"🐛": "[BUG]",
	"💥": "[CRASH]",
	"🔥": "[HOT]",
	"🔒": "[LOCK]",
	"🔓": "[UNLOCK]",
	"📁": "[DIR]",
	"📂": "[DIR]",
	"📄": "[FILE]",
	"📝": "[NOTE]",
	"🧪": "[TEST]",
	"⏳": "[WAIT]",
	"⌛": "[WAIT]",
	"🚀": "[RUN]"
};

const CHAR_FOLD = {
	"\u2018": "'",
	"\u2019": "'",
	"\u201a": "'",
	"\u201b": "'",
	"\u201c": '"',
	"\u201d": '"',
	"\u201e": '"',
	"\u2032": "'",
	"\u2033": '"',
	"\u2035": "'",
	"\u2036": '"',
	"\u2039": "<",
	"\u203a": ">",
	"\u2010": "-",
	"\u2011": "-",
	"\u2012": "-",
	"\u2013": "-",
	"\u2014": "-",
	"\u2015": "-",
	"\u2212": "-",
	"\u2044": "/",
	"\u2024": ".",
	"\u2025": "..",
	"\u2026": "...",
	"\u22ef": "...",
	"\u2022": "*",
	"\u2023": "*",
	"\u2043": "-",
	"\u2219": "*",
	"\u25cf": "*",
	"\u25a0": "*",
	"\u25aa": "*",
	"\u2190": "<-",
	"\u2191": "^",
	"\u2192": "->",
	"\u2193": "v",
	"\u2194": "<->",
	"\u21d0": "<=",
	"\u21d2": "=>",
	"\u21d4": "<=>",
	"\u2713": "v",
	"\u2714": "v",
	"\u2717": "x",
	"\u2718": "x"
};

const COMBINING_MARKS = /\p{M}+/gu;
const EMOJI_PICTOGRAPH = /\p{Extended_Pictographic}/u;
const UNRENDERABLE = /[\p{Cc}\p{Mn}\p{Me}\p{Cs}]/u;
const COLLAPSIBLE = /[\s\p{Cf}]+/gu;
const LINE_BREAK = /[\n\r\u2028\u2029]/;
const EDGE_RUNS = /^[ \u2588]+|[ \u2588]+$/g;

// ============================================================================
// Shapes & Geometry
// ============================================================================

export const SHAPE_VARIANTS = {
	"11on16-bw": { font: "8x13", cellWidth: 11, cellHeight: 16, stretch: false, variant: "bw", lineRepeat: 1, frameSize: 1568 },
	"8on22-bw": { font: "8x13", cellWidth: 8, cellHeight: 22, stretch: false, variant: "bw", lineRepeat: 1, frameSize: 1568 },
	"silver16-bw": { font: "silver", cellWidth: 16, cellHeight: 16, variant: "bw", lineRepeat: 1, frameSize: 1568 },
	"8on16-bw": { font: "8x13", cellWidth: 8, cellHeight: 16, stretch: false, variant: "bw", lineRepeat: 1, frameSize: 1568 },
	"6x12-dim": { font: "6x12", cellWidth: 6, cellHeight: 12, variant: "bw", stopwordDim: true, lineRepeat: 1, frameSize: 1568 },
	"8x8r-bw": { font: "8x8", cellWidth: 8, cellHeight: 8, variant: "bw", lineRepeat: 2, frameSize: 1568 },
	"8x8u-bw": { font: "8x8", cellWidth: 8, cellHeight: 8, variant: "bw", lineRepeat: 1, frameSize: 1568 },
	"6x6u-bw": { font: "8x8", cellWidth: 6, cellHeight: 6, variant: "bw", lineRepeat: 1, frameSize: 1568 },
	"5x8-bw": { font: "5x8", cellWidth: 5, cellHeight: 8, variant: "bw", lineRepeat: 1, frameSize: 2576 },
	"doc-8on16-bw": { font: "8x13", cellWidth: 8, cellHeight: 16, stretch: false, variant: "bw", columns: 2, lineRepeat: 1, frameSize: 1568 }
};

export const SHAPES = {
	anthropic: { ...SHAPE_VARIANTS["11on16-bw"], frameTokenEstimate: 3136 },
	google: { ...SHAPE_VARIANTS["8on22-bw"], frameTokenEstimate: 1120 },
	openai: { ...SHAPE_VARIANTS["8on22-bw"], frameTokenEstimate: 2881, imageDetail: "original" },
	cjk: { ...SHAPE_VARIANTS["silver16-bw"], frameTokenEstimate: 3136 }
};

export function geometry(shape, size = shape.frameSize) {
	const gridCols = Math.floor(size / shape.cellWidth);
	const rows = Math.floor(size / shape.cellHeight / shape.lineRepeat);
	if (shape.columns === 2) {
		const cols = Math.floor((gridCols - 3) / 2);
		return { cols, rows, capacity: 2 * cols * rows };
	}
	return { cols: gridCols, rows, capacity: gridCols * rows };
}

export function isWideCodePoint(cp) {
	return (
		(cp >= 0x1100 && cp <= 0x115f) ||
		(cp >= 0x2e80 && cp <= 0x2eff) ||
		(cp >= 0x2f00 && cp <= 0x2fdf) ||
		(cp >= 0x3000 && cp <= 0x303e) ||
		(cp >= 0x3041 && cp <= 0x33ff) ||
		(cp >= 0x3400 && cp <= 0x4dbf) ||
		(cp >= 0x4e00 && cp <= 0x9fff) ||
		(cp >= 0xa000 && cp <= 0xa4cf) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe30 && cp <= 0xfe4f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x20000 && cp <= 0x2fffd) ||
		(cp >= 0x30000 && cp <= 0x3fffd)
	);
}

export function charCells(ch, wideCells) {
	if (ch === DIM_ON || ch === DIM_OFF) return 0;
	const cp = ch.codePointAt(0);
	return wideCells && cp !== undefined && isWideCodePoint(cp) ? 2 : 1;
}

export function usesWideCells(shape) {
	return shape.font !== "silver";
}

export function resolveShape(target) {
	const provider = (target && target.provider ? String(target.provider) : "").toLowerCase();
	const model = (target && target.model ? String(target.model) : "").toLowerCase();

	if (provider.includes("anthropic") || model.includes("claude")) {
		return SHAPES.anthropic;
	}
	if (provider.includes("google") || model.includes("gemini")) {
		return SHAPES.google;
	}
	if (provider.includes("openai") || model.includes("gpt")) {
		return SHAPES.openai;
	}
	return SHAPES.anthropic;
}

export function resolveShapeForText(text, target) {
	let cjkCount = 0;
	for (const ch of text) {
		const cp = ch.codePointAt(0);
		if (cp && isWideCodePoint(cp)) {
			cjkCount++;
			if (cjkCount > 10) return SHAPES.cjk;
		}
	}
	return resolveShape(target);
}

// ============================================================================
// Text Normalization & Processing
// ============================================================================

function isAsciiOrLatin1(cp) {
	return (cp >= 0x20 && cp < 0x7f) || (cp >= 0xa0 && cp <= 0xff);
}

function foldToAscii(ch) {
	const decomposed = ch.normalize("NFKD").replace(COMBINING_MARKS, "");
	if (decomposed === ch) return undefined;
	let out = "";
	for (const part of decomposed) {
		const cp = part.codePointAt(0);
		if (cp !== undefined && isAsciiOrLatin1(cp)) {
			out += part;
			continue;
		}
		const fold = CHAR_FOLD[part];
		if (fold === undefined) return undefined;
		out += fold;
	}
	return out;
}

export function normalize(text, options = {}) {
	const raw = text
		.replace(ANSI_PATTERN, "")
		.replace(COLLAPSIBLE, run => (LINE_BREAK.test(run) ? NEWLINE_GLYPH : " "));

	const font = options.font || (options.shape && options.shape.font) || "8x13";
	const out = [];

	for (const ch of raw) {
		const cp = ch.codePointAt(0);
		if (cp === undefined) continue;

		if (isAsciiOrLatin1(cp) || ch === DIM_ON || ch === DIM_OFF || ch === NEWLINE_GLYPH) {
			out.push(ch);
			continue;
		}

		const emoji = EMOJI_FOLD[ch];
		if (emoji !== undefined) {
			out.push(emoji);
			continue;
		}

		const fold = CHAR_FOLD[ch];
		if (fold !== undefined) {
			out.push(fold);
			continue;
		}

		if (cp >= 0x2500 && cp <= 0x257f) {
			out.push(cp === 0x2502 || cp === 0x2503 ? "|" : cp === 0x2500 || cp === 0x2501 ? "-" : "+");
			continue;
		}

		if (font === "silver" && isWideCodePoint(cp)) {
			out.push(ch);
			continue;
		}

		const folded = foldToAscii(ch);
		if (folded !== undefined) {
			out.push(folded);
		} else if (!EMOJI_PICTOGRAPH.test(ch) && !UNRENDERABLE.test(ch)) {
			out.push("?");
		}
	}

	return out.join("").replace(/ +/g, " ").replace(EDGE_RUNS, "");
}

export function dimStopwords(text) {
	const parts = text.split(/([\u000e\u000f])/);
	let dim = false;
	let out = "";
	for (const part of parts) {
		if (part === DIM_ON) {
			dim = true;
			out += part;
		} else if (part === DIM_OFF) {
			dim = false;
			out += part;
		} else if (dim) {
			out += part;
		} else {
			out += part.replace(/[a-zA-Z]+/g, word => (STOPWORDS.has(word.toLowerCase()) ? DIM_ON + word + DIM_OFF : word));
		}
	}
	return out;
}

export function paginateCells(text, capacity, cols, wideCells) {
	const chars = [...text];
	const pages = [];
	let start = 0;
	let cell = 0;
	let hasCell = false;

	for (let i = 0; i < chars.length; i++) {
		const w = charCells(chars[i] || "", wideCells);
		if (w === 0) continue;
		let at = cell;
		if (w === 2 && cols >= 2 && at % cols === cols - 1) at += 1;
		if (hasCell && at + w > capacity) {
			pages.push(chars.slice(start, i).join(""));
			start = i;
			at = 0;
		}
		cell = at + w;
		hasCell = true;
	}
	if (hasCell) pages.push(chars.slice(start).join(""));
	return pages;
}

// ============================================================================
// Conversation Serialization
// ============================================================================

export function serializeConversation(eventsOrMessages, options = {}) {
	const toolResultMaxChars = options.toolResultMaxChars ?? 4000;
	const toolArgMaxChars = options.toolArgMaxChars ?? 600;
	const dimToolResults = options.dimToolResults !== false;
	const includeThinking = options.includeThinking !== false;

	const parts = [];
	let lastPrefix = null;

	const pushPart = (prefix, content) => {
		const trimmed = content.trim();
		if (!trimmed) return;
		const lastIndex = parts.length - 1;
		if (lastIndex >= 0 && lastPrefix === prefix) {
			parts[lastIndex] += "\n" + trimmed;
		} else {
			parts.push(prefix + " " + trimmed);
			lastPrefix = prefix;
		}
	};

	const fileOps = { read: new Set(), written: new Set() };

	for (const item of eventsOrMessages) {
		let msg = item;
		if (item.data && (item.type === "user/message" || item.type === "assistant/message")) {
			msg = item.type === "user/message" ? item.data : item.data.message;
		}

		if (!msg) continue;

		if (msg.role === "user") {
			const text = Array.isArray(msg.content)
				? msg.content.filter(b => b && b.type === "text").map(b => b.text).join("\n")
				: typeof msg.content === "string" ? msg.content : "";
			if (text) pushPart("¶user:", text.replace(DIM_MARKERS, ""));
		} else if (msg.role === "assistant") {
			if (Array.isArray(msg.content)) {
				let pendingThinking = [];
				let pendingText = [];

				const flush = () => {
					if (pendingThinking.length > 0) pushPart("¶think:", pendingThinking.join("\n"));
					if (pendingText.length > 0) pushPart("¶ai:", pendingText.join("\n"));
					pendingThinking = [];
					pendingText = [];
				};

				for (const block of msg.content) {
					if (!block) continue;
					if (block.type === "text" && block.text) {
						pendingText.push(block.text.replace(DIM_MARKERS, ""));
					} else if (block.type === "reasoning" && block.text && includeThinking) {
						pendingThinking.push(block.text.replace(DIM_MARKERS, ""));
					} else if (block.type === "tool-call") {
						flush();
						const name = block.name || "tool";
						let argsStr = "";
						try {
							const args = typeof block.arguments === "string" ? JSON.parse(block.arguments) : block.arguments;
							if (args && typeof args === "object") {
								// Track file operations
								const filePath = args.file_path || args.path || args.file;
								if (typeof filePath === "string") {
									if (name.includes("write") || name.includes("edit") || name.includes("create")) {
										fileOps.written.add(filePath);
									} else if (name.includes("read") || name.includes("cat") || name.includes("glob") || name.includes("grep")) {
										fileOps.read.add(filePath);
									}
								}

								argsStr = Object.entries(args)
									.map(([k, v]) => `${k}=${JSON.stringify(v)}`.slice(0, toolArgMaxChars))
									.join(", ");
							}
						} catch {
							argsStr = String(block.arguments || "").slice(0, toolArgMaxChars);
						}
						pushPart("¶call:", `${name}(${argsStr})`);
					}
				}
				flush();
			}
		} else if (msg.type === "tool/result" || (Array.isArray(msg.content) && msg.content.some(b => b && b.type === "tool-result"))) {
			// Tool result
			let resultText = "";
			if (msg.type === "tool/result" && msg.data) {
				resultText = typeof msg.data.content === "string" ? msg.data.content : JSON.stringify(msg.data.content);
			} else if (Array.isArray(msg.content)) {
				for (const b of msg.content) {
					if (b && b.type === "tool-result") {
						const body = Array.isArray(b.content) ? b.content.filter(x => x && x.type === "text").map(x => x.text).join("\n") : String(b.content || "");
						resultText += body;
					}
				}
			}

			if (resultText) {
				const truncated = resultText.slice(0, toolResultMaxChars).replace(DATA_URL_RE, "[data:image/...]");
				const formatted = `<out>\n${dimToolResults ? DIM_ON + truncated + DIM_OFF : truncated}\n</out>`;
				pushPart("¶call:", formatted);
			}
		}
	}

	return {
		transcript: parts.join("\n\n"),
		fileOps
	};
}

// ============================================================================
// Archive Planning & Layout
// ============================================================================

export function planArchive(text, highShape, maxFrames = 8) {
	const geo = geometry(highShape);
	const cap = geo.capacity;
	const edgeCap = cap; // 1 page at each edge

	if (text.length <= 2 * edgeCap) {
		return { frames: [], textHead: text, textTail: "", truncatedChars: 0 };
	}

	const textHead = text.slice(0, edgeCap);
	const textTail = text.slice(text.length - edgeCap);
	const middleText = text.slice(edgeCap, text.length - edgeCap);

	const wideCells = usesWideCells(highShape);
	const pages = paginateCells(middleText, cap, geo.cols, wideCells);

	let keptPages = pages;
	let truncatedChars = 0;

	if (pages.length > maxFrames) {
		// Keep HQ head frames and tail frames, drop dense center slice
		const edgeBudget = Math.min(3, Math.floor((maxFrames - 1) / 2));
		const headP = pages.slice(0, edgeBudget);
		const tailP = edgeBudget > 0 ? pages.slice(pages.length - edgeBudget) : [];
		const middleP = pages.slice(edgeBudget, pages.length - edgeBudget);
		const middleBudget = maxFrames - headP.length - tailP.length;

		const keptMiddle = middleP.slice(middleP.length - middleBudget);
		truncatedChars = middleP.slice(0, middleP.length - middleBudget).reduce((s, p) => s + p.length, 0);

		keptPages = [...headP, ...keptMiddle, ...tailP];
	}

	return {
		frames: keptPages.map(page => ({ text: page, shape: highShape })),
		textHead,
		textTail,
		truncatedChars
	};
}

// ============================================================================
// File Operations Summary
// ============================================================================

export function formatFileOperations(fileOps) {
	const readFiles = [...(fileOps.read || [])].filter(f => !f.includes("://")).sort();
	const writtenFiles = [...(fileOps.written || [])].filter(f => !f.includes("://")).sort();

	if (readFiles.length === 0 && writtenFiles.length === 0) return "";

	const lines = [];
	const writtenSet = new Set(writtenFiles);

	for (const file of readFiles) {
		lines.push(`- ${file} ${writtenSet.has(file) ? "(RW)" : "(Read)"}`);
	}
	for (const file of writtenFiles) {
		if (!readFiles.includes(file)) {
			lines.push(`- ${file} (Write)`);
		}
	}

	return lines.slice(0, 30).join("\n");
}

// ============================================================================
// Reading Guide & Checkpoint Message
// ============================================================================

export function buildReadingGuide(options) {
	const { frameCount, cols, rows, filesFormatted, truncatedChars } = options;

	let guide = `Resume prior conversation. Earlier turns archived under HISTORY below, oldest→newest. Read HISTORY fully; continue the live conversation following it.

Archived transcript scopes:
- \`¶user:\`, \`¶think:\`, \`¶ai:\`, \`¶call:\`: user, assistant reasoning, assistant reply, tool call.
- Unprefixed following lines: current scope. Consecutive same-kind blocks omit repeated prefix.
- Tool call: \`¶call:name(args)//intent\`; trailing \`//intent\` optional. \`<out>…</out>\`: tool output.

Reading HISTORY:
- Plain text: verbatim transcript; rely on it exactly.`;

	if (frameCount > 0) {
		guide += `\n- Middle sections: images, not text. Each image: one page of that transcript, in reading order between marked delimiters. Solid black cell (█): newline; runs of spaces collapse to one.
  - Frame: one grid ${cols} characters wide, up to ${rows} rows tall; read left→right, top→bottom. No word wrap; words may break across rows.`;
	}

	if (truncatedChars > 0) {
		guide += `\n- About ${truncatedChars} characters of older middle history dropped to fit archive budget.`;
	}

	guide += `\n- If an exact earlier detail matters and a section is unclear, re-derive from workspace (re-read files, re-run commands), rather than guess.`;

	if (filesFormatted) {
		guide += `\n\nFILES\n===================\n${filesFormatted}`;
	}

	guide += `\n\nHISTORY\n===================`;

	return guide;
}

// ============================================================================
// Snapcompact Configuration Persistence
// ============================================================================

function getConfigPath() {
	const base = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
	return path.join(base, "snapcompact-config.json");
}

function loadStoredConfig() {
	try {
		const file = getConfigPath();
		if (fs.existsSync(file)) {
			return JSON.parse(fs.readFileSync(file, "utf8"));
		}
	} catch {}
	return {};
}

function saveStoredConfig(cfg) {
	try {
		const file = getConfigPath();
		const dir = path.dirname(file);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(file, JSON.stringify(cfg, null, 2), "utf8");
	} catch {}
}

// ============================================================================
// Snapcompact Engine Implementation
// ============================================================================

export class SnapcompactEngine extends Service {
	static inject = ["attachments", "sessions", "tokenMeter"];

	constructor(ctx, config = {}) {
		super(ctx, "snapcompact");
		const stored = loadStoredConfig();
		this.config = {
			maxFrames: config.maxFrames ?? stored.maxFrames ?? 8,
			thresholdRatio: config.thresholdRatio ?? stored.thresholdRatio ?? 0.8,
			retainRatio: config.retainRatio ?? stored.retainRatio ?? 0.16,
			autoIdle: config.autoIdle ?? stored.autoIdle ?? false,
			auto: config.auto ?? false,
			debounceMs: config.debounceMs ?? stored.debounceMs ?? 1500,
			minTokens: config.minTokens ?? stored.minTokens ?? 4000,
			...config
		};

		this.idleTimers = new Map();
		this.isCompacting = new Set();

		this._registerIdleListener();
		if (this.config.auto) {
			this._registerAutoCompaction();
		}
	}

	saveConfig() {
		saveStoredConfig({
			autoIdle: this.config.autoIdle,
			thresholdRatio: this.config.thresholdRatio,
			retainRatio: this.config.retainRatio,
			maxFrames: this.config.maxFrames,
			minTokens: this.config.minTokens
		});
	}

	toggleAutoIdle(enable) {
		if (typeof enable === "boolean") {
			this.config.autoIdle = enable;
		} else {
			this.config.autoIdle = !this.config.autoIdle;
		}
		this.saveConfig();
		return this.config.autoIdle;
	}

	setThreshold(ratio) {
		this.config.thresholdRatio = Math.max(0.1, Math.min(0.95, ratio));
		this.saveConfig();
		return this.config.thresholdRatio;
	}

	_registerIdleListener() {
		const { ctx } = this;
		ctx.on("agent/status", ({ agent, status }) => {
			if (!agent) return;
			if (status !== "idle") {
				this._cancelIdleTimer(agent);
				return;
			}
			if (!this.config.autoIdle) return;
			this._scheduleIdleCompaction(agent);
		});
	}

	_cancelIdleTimer(agent) {
		const existing = this.idleTimers.get(agent.id);
		if (existing) {
			clearTimeout(existing);
			this.idleTimers.delete(agent.id);
		}
	}

	_scheduleIdleCompaction(agent) {
		this._cancelIdleTimer(agent);
		const timer = setTimeout(async () => {
			this.idleTimers.delete(agent.id);
			if (!this.config.autoIdle) return;
			if (agent.status !== "idle") return;
			if (this.isCompacting.has(agent.id)) return;

			const meter = this.ctx.tokenMeter;
			if (!meter) return;

			try {
				const measurement = meter.measure(agent.session);
				const header = agent.session.requestHeader();
				const contextWindow = header?.config?.contextWindow ?? 128000;
				const threshold = contextWindow * this.config.thresholdRatio;

				if (measurement.totalTokens < threshold || measurement.totalTokens < this.config.minTokens) {
					return;
				}

				this.ctx.logger?.info?.(
					`[snapcompact] auto-idle triggered for agent ${agent.id}: ${measurement.totalTokens} tokens >= ${Math.round(threshold)} threshold`
				);

				this.isCompacting.add(agent.id);
				try {
					if (typeof agent.runMaintenance === "function") {
						await agent.runMaintenance(async (maintenanceSignal) => {
							await this.compactNow(agent, maintenanceSignal, undefined, {
								auto: true,
								alreadyInMaintenance: true
							});
						});
					} else {
						await this.compactNow(agent, undefined, undefined, {
							auto: true,
							alreadyInMaintenance: true
						});
					}
				} finally {
					this.isCompacting.delete(agent.id);
				}
			} catch (err) {
				this.ctx.logger?.warn?.(`[snapcompact] auto-idle compaction failed: ${err.message}`);
			}
		}, this.config.debounceMs);

		this.idleTimers.set(agent.id, timer);
	}

	_registerAutoCompaction() {
		const { ctx } = this;
		ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
			if (!signal.aborted) {
				try {
					await this.compactIfNeeded(agent, "pressure", signal);
				} catch (err) {
					ctx.logger?.warn?.(`snapcompact step-pressure failed: ${err.message}`);
				}
			}
			return next();
		});

		ctx.on("agent/request-error", async ({ agent, failure, signal }, next) => {
			if (failure && failure.code === "CONTEXT_WINDOW_EXCEEDED" && !signal.aborted) {
				try {
					const res = await this.compactIfNeeded(agent, "context-overflow", signal);
					if (res !== null) return { kind: "retry" };
				} catch (err) {
					ctx.logger?.warn?.(`snapcompact overflow recovery failed: ${err.message}`);
				}
			}
			return next();
		});
	}

	async compactIfNeeded(agent, trigger, signal) {
		signal?.throwIfAborted();
		const session = agent.session;
		const meter = this.ctx.tokenMeter;
		if (!meter) return null;

		const measurement = meter.measure(session);
		const header = session.requestHeader();
		const contextWindow = header?.config?.contextWindow ?? 128000;
		const threshold = trigger === "context-overflow" ? 0 : contextWindow * this.config.thresholdRatio;

		if (measurement.totalTokens < threshold && trigger !== "context-overflow") {
			return null;
		}

		const retainTokens = Math.round(contextWindow * this.config.retainRatio);
		const range = this._selectRange(session, measurement, retainTokens);
		if (!range) return null;

		return this.compactRegion(range.start, range.end, agent, signal);
	}

	async compactNow(agent, signal, sourceCommandId, options = {}) {
		signal?.throwIfAborted();
		const session = agent.session;
		const meter = this.ctx.tokenMeter;

		let range = null;
		if (meter) {
			const measurement = meter.measure(session);
			const contextWindow = session.requestHeader()?.config?.contextWindow ?? 128000;
			const retainTokens = options.retainTokens !== undefined
				? options.retainTokens
				: Math.round(contextWindow * this.config.retainRatio);
			range = this._selectRange(session, measurement, retainTokens);
		}

		if (!range) {
			// Fallback range selection based on surface nodes
			const nodes = session.surface.nodes;
			if (nodes.length <= 2) return null;
			const start = nodes[0];
			let endIdx = nodes.length - 2;
			while (endIdx > 0 && !toolPairingBalancedAfter(session, nodes[endIdx])) {
				endIdx--;
			}
			if (endIdx <= 0) return null;
			range = { start, end: nodes[endIdx] };
		}

		const doCompact = (execSignal) => this.compactRegion(range.start, range.end, agent, execSignal, {
			sourceCommandId,
			...options
		});

		if (agent.status === "idle" && typeof agent.runMaintenance === "function" && !options.alreadyInMaintenance) {
			return agent.runMaintenance(async (maintenanceSignal) => {
				const opSignal = signal ? AbortSignal.any([signal, maintenanceSignal]) : maintenanceSignal;
				return doCompact(opSignal);
			});
		}

		return doCompact(signal);
	}

	async compactRegion(start, end, agent, signal, options = {}) {
		signal?.throwIfAborted();
		const session = agent.session;
		const nodes = session.surface.nodes;
		const startIdx = nodes.indexOf(start);
		const endIdx = nodes.indexOf(end);

		if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
			throw new ManualCompactionError("changed", "Invalid surface range for snapcompact");
		}

		if (!toolPairingBalancedBefore(session, start)) {
			throw new ManualCompactionError("changed", "Start sequence splits a tool pairing");
		}
		if (!toolPairingBalancedAfter(session, end)) {
			throw new ManualCompactionError("changed", "End sequence splits a tool pairing");
		}

		const shadowedSeqs = nodes.slice(startIdx, endIdx + 1);
		const compactionId = CompactionId(randomUUID());
		const lifecycle = {
			compactionId,
			...(options.sourceCommandId ? { sourceCommandId: options.sourceCommandId } : {})
		};

		// 1. Acquire durable lock
		const startEvent = session.append("compaction/start", lifecycle);
		let closed = false;

		try {
			// 2. Collect messages from shadowed sequences
			const shadowedEvents = shadowedSeqs.map(seq => session.eventAt(seq)).filter(Boolean);
			const { transcript, fileOps } = serializeConversation(shadowedEvents);

			// 3. Resolve shape
			const target = {
				provider: agent.options?.provider || session.requestHeader()?.config?.provider,
				model: agent.options?.model || session.requestHeader()?.config?.model
			};
			const shape = options.shape ? (SHAPE_VARIANTS[options.shape] || SHAPES.anthropic) : resolveShapeForText(transcript, target);
			const geo = geometry(shape);

			// 4. Normalize & Plan Archive
			const normalized = normalize(transcript, { shape });
			const layout = planArchive(normalized, shape, options.maxFrames || this.config.maxFrames);

			// 5. Render PNG frames
			const renderedPngs = await Promise.all(
				layout.frames.map(frame =>
					renderPng(frame.text, {
						size: shape.frameSize,
						font: shape.font,
						cellWidth: shape.cellWidth,
						cellHeight: shape.cellHeight,
						stretch: shape.stretch,
						variant: shape.variant,
						lineRepeat: shape.lineRepeat,
						columns: shape.columns
					})
				)
			);

			// 6. Save image attachments
			const attachments = this.ctx.attachments;
			if (!attachments) {
				throw new Error("attachments service is required for snapcompact");
			}

			const imageInputs = renderedPngs.map((b64, idx) => ({
				data: new Uint8Array(Buffer.from(b64, "base64")),
				mediaType: "image/png",
				name: `snapcompact-frame-${idx + 1}.png`
			}));

			const imageRefs = await attachments.saveImages(imageInputs);

			// 7. Format reading guide and construct replacement UserMessage
			const filesFormatted = formatFileOperations(fileOps);
			const readingGuide = buildReadingGuide({
				frameCount: imageRefs.length,
				cols: geo.cols,
				rows: geo.rows,
				filesFormatted,
				truncatedChars: layout.truncatedChars
			});

			const contentBlocks = [];
			let headText = readingGuide;
			if (layout.textHead) {
				headText += `\n\n${layout.textHead}`;
			}
			if (imageRefs.length > 0) {
				headText += `\n\n-------------- imaged middle below\n`;
			}
			contentBlocks.push({ type: "text", text: headText });

			for (const ref of imageRefs) {
				contentBlocks.push({ type: "image", attachment: ref });
			}

			if (layout.textTail) {
				contentBlocks.push({
					type: "text",
					text: `-------------- imaged middle above\n\n${layout.textTail}`
				});
			}

			const checkpointMessage = createUserMessage({
				content: contentBlocks,
				source: compactCheckpointSource(compactionId, options.sourceCommandId)
			});

			// 8. Commit compaction summary & surface replacement
			const summaryEvent = session.append("compaction/summary", {
				compactionId,
				...(options.sourceCommandId ? { sourceCommandId: options.sourceCommandId } : {}),
				summary: [{ type: "text", text: `Snapcompact archived ${normalized.length} characters into ${imageRefs.length} frames.` }],
				rawOutput: readingGuide,
				shadowedRange: { start, end },
				shadowedSeqs: [...shadowedSeqs],
				shadowedTokenCount: Math.round(normalized.length / 3.5),
				provider: target.provider || "snapcompact",
				model: target.model || "bitmap-frame"
			});

			session.append("user/message", checkpointMessage, {
				surfaceOp: {
					op: "replace",
					startSeq: start,
					endSeq: end
				},
				sourceEventSeqs: [
					startEvent.seq,
					summaryEvent.seq,
					...shadowedSeqs
				]
			});

			// 9. Release durable lock
			const endEvent = session.append("compaction/end", lifecycle);
			closed = true;

			if (this.ctx.sessions && typeof this.ctx.sessions.flush === "function") {
				try {
					await this.ctx.sessions.flush(session);
				} catch {}
			}

			return {
				compactionId,
				...(options.sourceCommandId ? { sourceCommandId: options.sourceCommandId } : {}),
				startSeq: startEvent.seq,
				summarySeq: summaryEvent.seq,
				endSeq: endEvent.seq,
				summary: contentBlocks,
				shadowedRange: { start, end },
				shadowedSeqs: [...shadowedSeqs],
				shadowedTokenCount: Math.round(normalized.length / 3.5),
				frameCount: imageRefs.length,
				archivedChars: normalized.length
			};
		} catch (err) {
			if (!closed) {
				try {
					session.append("compaction/end", {
						...lifecycle,
						error: err.message
					});
				} catch {}
			}
			throw err;
		}
	}

	_selectRange(session, measurement, retainTokens) {
		const pricedNodes = measurement.nodes;
		if (pricedNodes.length === 0) return null;
		const surfaceNodes = session.surface.nodes;
		const firstIdx = session.eventAt(surfaceNodes[0])?.type === "system/message" ? 1 : 0;

		let accumulated = 0;
		let keepFromIdx = pricedNodes.length;
		for (let i = pricedNodes.length - 1; i >= 0; i--) {
			accumulated += pricedNodes[i].tokens;
			keepFromIdx = i;
			if (accumulated >= retainTokens) break;
		}

		if (keepFromIdx <= firstIdx) return null;
		while (keepFromIdx > firstIdx) {
			if (toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx])) break;
			keepFromIdx--;
		}

		if (keepFromIdx <= firstIdx) return null;
		return {
			start: surfaceNodes[firstIdx],
			end: surfaceNodes[keepFromIdx - 1]
		};
	}
}

// ============================================================================
// Plugin Application
// ============================================================================

export const inject = ["attachments", "sessions", "tokenMeter", "commands"];

export function apply(ctx) {
	// Register SnapcompactEngine as snapcompact service
	const engine = new SnapcompactEngine(ctx);

	// Register human command /snapcompact
	if (ctx.commands && typeof ctx.commands.register === "function") {
		ctx.effect(() => {
			return ctx.commands.register({
				name: "snapcompact",
				description: "Archive earlier conversation history into dense bitmap image frames for vision models",
				input: {
					hint: "[auto [on|off] | status] [--frames N] [--all]",
					images: false
				},
				async handler(invocation) {
					const raw = (invocation.rawInput || "").trim();
					const agent = invocation.agent;
					if (!agent) {
						return { kind: "error", text: "No active agent found for compaction." };
					}

					// 1. Check for 'auto' / toggle commands
					if (/^auto(\s+.*)?$/i.test(raw) || /^(on|off|enable|disable)$/i.test(raw)) {
						const sub = raw.replace(/^auto\s*/i, "").trim().toLowerCase();
						if (!sub || sub === "toggle") {
							const current = engine.toggleAutoIdle();
							return {
								kind: "success",
								text: `Auto snapcompact on idle: ${current ? "ENABLED" : "DISABLED"}\n` +
									(current
										? `(Archives conversation in background when idle and context exceeds ${Math.round(engine.config.thresholdRatio * 100)}%)`
										: `(Use '/snapcompact auto on' to enable, or run '/snapcompact' manually)`)
							};
						}
						if (sub === "on" || sub === "enable" || sub === "1" || sub === "true") {
							engine.toggleAutoIdle(true);
							return {
								kind: "success",
								text: `Auto snapcompact on idle: ENABLED\nTriggers automatically in the background when the agent is idle and context usage exceeds ${Math.round(engine.config.thresholdRatio * 100)}% (${Math.round(engine.config.retainRatio * 100)}% recent history retained in plain text).`
							};
						}
						if (sub === "off" || sub === "disable" || sub === "0" || sub === "false") {
							engine.toggleAutoIdle(false);
							return {
								kind: "success",
								text: "Auto snapcompact on idle: DISABLED."
							};
						}
						const threshMatch = sub.match(/^(?:threshold|ratio)\s+(\d+(?:\.\d+)?)/i);
						if (threshMatch) {
							let val = parseFloat(threshMatch[1]);
							if (val > 1) val = val / 100;
							engine.setThreshold(val);
							return {
								kind: "success",
								text: `Auto snapcompact trigger threshold set to ${Math.round(engine.config.thresholdRatio * 100)}% context window.`
							};
						}
						return {
							kind: "error",
							text: `Unknown auto command: '${raw}'. Usage: /snapcompact auto [on|off|toggle|threshold <percent>]`
						};
					}

					// 2. Check for 'status' command
					if (/^(status|info|settings)$/i.test(raw)) {
						const meter = ctx.tokenMeter;
						const session = agent.session;
						let tokenInfo = "";
						if (meter && session) {
							try {
								const m = meter.measure(session);
								const cw = session.requestHeader()?.config?.contextWindow ?? 128000;
								const pct = Math.round((m.totalTokens / cw) * 100);
								tokenInfo = `\nCurrent Session:\n- Tokens used: ${m.totalTokens.toLocaleString()} / ${cw.toLocaleString()} (${pct}%)\n- Idle threshold: ${Math.round(cw * engine.config.thresholdRatio).toLocaleString()} tokens (${Math.round(engine.config.thresholdRatio * 100)}%)`;
							} catch {}
						}

						return {
							kind: "success",
							text: `Snapcompact Configuration:\n` +
								`- Auto when idle: ${engine.config.autoIdle ? "ENABLED" : "DISABLED"}\n` +
								`- Idle threshold: ${Math.round(engine.config.thresholdRatio * 100)}% of context window\n` +
								`- Plaintext retained: ${Math.round(engine.config.retainRatio * 100)}% recent history\n` +
								`- Max bitmap frames: ${engine.config.maxFrames}\n` +
								`- Shape: Auto-detected (Anthropic: 11on16-bw | Google/OpenAI: 8on22-bw | CJK: silver16-bw)${tokenInfo}`
						};
					}

					// 3. Check for 'help' command
					if (/^(help|\?)$/i.test(raw)) {
						return {
							kind: "success",
							text: `Snapcompact Commands:\n` +
								`  /snapcompact               - Archive older history immediately using smart defaults\n` +
								`  /snapcompact auto          - Toggle automatic idle compaction on/off\n` +
								`  /snapcompact auto on|off   - Enable or disable automatic idle compaction\n` +
								`  /snapcompact auto threshold <pct> - Set idle trigger threshold (e.g. 75)\n` +
								`  /snapcompact status        - View current config and token usage\n` +
								`  /snapcompact --frames <N>  - Manual archive with specific frame count limit\n` +
								`  /snapcompact --shape <S>   - Manual archive with specific font/shape variant\n` +
								`  /snapcompact --all         - Manual archive of all compactable history`
						};
					}

					let maxFrames = 8;
					let shape = undefined;
					let retainTokens = undefined;

					const framesMatch = raw.match(/--frames\s+(\d+)/i);
					if (framesMatch) maxFrames = Math.max(1, parseInt(framesMatch[1], 10));

					const shapeMatch = raw.match(/--shape\s+([a-z0-9-]+)/i);
					if (shapeMatch) shape = shapeMatch[1];

					if (raw.includes("--all")) retainTokens = 0;

					try {
						const result = await engine.compactNow(agent, invocation.signal, invocation.commandId, {
							maxFrames,
							shape,
							retainTokens
						});

						if (!result) {
							return { kind: "success", text: "No compactable history found to archive." };
						}

						return {
							kind: "success",
							text: `Snapcompact: Archived ${result.archivedChars?.toLocaleString() || result.shadowedTokenCount * 3} characters onto ${result.frameCount || 0} bitmap frames (~${result.shadowedTokenCount?.toLocaleString()} tokens freed).`,
							sourceEventSeq: result.summarySeq
						};
					} catch (err) {
						if (invocation.signal?.aborted) {
							return { kind: "error", text: "Snapcompact cancelled." };
						}
						return { kind: "error", text: `Snapcompact failed: ${err.message}` };
					}
				}
			});
		});
	}
}

export default {
	apply,
	inject,
	SnapcompactEngine
};
