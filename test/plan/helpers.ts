// Shared test helpers for the planner: generated docx/pdf samples, a fake LLM CLI, a Jev stub.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { JevClient } from '../../src/jev/client.ts';
import { JEV_MODEL, loadJevConfig } from '../../src/jev/config.ts';
import { Calibration } from '../../src/jev/gates.ts';
import { QUESTION_VERSION } from '../../src/jev/questions.ts';

export function tempDir(prefix = 'qa-plan-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Uncompressed (stored) ZIP with UTF-8 names — enough for a minimal .docx. */
export function zipStore(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** Minimal Word document: `body` is WordprocessingML inside <w:body>. Heading1 is declared so mammoth maps it to <h1>. */
export function docxBytes(body: string): Buffer {
  return zipStore({
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels':
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'word/styles.xml': `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`,
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>`,
  });
}

/** One-page PDF with a Helvetica text layer; one line per entry. */
export function pdfBytes(lines: string[]): Buffer {
  const content = `BT /F1 12 Tf 14 TL 72 720 Td ${lines.map((l) => `(${l.replace(/[()\\]/g, '\\$&')}) '`).join(' ')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export interface FakeLlm {
  /** Environment for createLlm/generatePlan (QA_CLAUDE_BIN / QA_CODEX_BIN point at the fake). */
  env: NodeJS.ProcessEnv;
  /** Every invocation: argv and stdin. */
  calls(): { args: string[]; stdin: string }[];
}

/**
 * Fake `claude` / `codex` CLI (a Node script). Replies are served in order; `codex` mode writes the reply to `-o`.
 * `rejectSchema` makes codex fail like the real API when `--output-schema` is passed; `sleepMs` delays every reply;
 * `printEnv` replies with the sorted names of the CLI's environment; `floodBytes` prints that many bytes to stdout first.
 */
export function fakeLlm(
  mode: 'claude' | 'codex',
  replies: string[],
  opts: { rejectSchema?: boolean; sleepMs?: number; claudeError?: boolean; printEnv?: boolean; floodBytes?: number } = {},
): FakeLlm {
  const dir = tempDir('qa-fake-llm-');
  const script = join(dir, mode);
  writeFileSync(join(dir, 'script.json'), JSON.stringify({ mode, replies, ...opts }));
  writeFileSync(
    script,
    `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const dir = ${JSON.stringify(dir)};
const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'script.json'), 'utf8'));
const stdin = fs.readFileSync(0, 'utf8');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ args, stdin }) + '\\n');
const counter = path.join(dir, 'count');
const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
const finish = () => {
  if (cfg.mode === 'codex' && cfg.rejectSchema && args.includes('--output-schema')) {
    process.stderr.write('ERROR: {"error":{"code":"invalid_json_schema","message":"Invalid schema for response_format"}}\\n');
    process.exit(1);
  }
  fs.writeFileSync(counter, String(n + 1));
  if (cfg.floodBytes) process.stdout.write('x'.repeat(cfg.floodBytes));
  const reply = cfg.printEnv ? JSON.stringify(Object.keys(process.env).sort()) : cfg.replies[Math.min(n, cfg.replies.length - 1)];
  if (cfg.mode === 'claude') {
    process.stdout.write(JSON.stringify(cfg.claudeError ? { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' } : { type: 'result', subtype: 'success', is_error: false, result: reply }));
  } else {
    fs.writeFileSync(args[args.indexOf('-o') + 1], reply);
  }
};
if (cfg.sleepMs) setTimeout(finish, cfg.sleepMs); else finish();
`,
  );
  chmodSync(script, 0o755);
  const env = { ...process.env, [mode === 'claude' ? 'QA_CLAUDE_BIN' : 'QA_CODEX_BIN']: script, QA_LLM: undefined, QA_LLM_MODEL: undefined };
  return {
    env,
    calls: () => {
      try {
        return readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
  };
}

const criteria = { maxConfidentWrong: 0, minAcceptance: 0.8 };

/** Only the review section is calibrated (architecture §6 thresholds); the planner uses nothing else. */
export const TEST_CALIBRATION: Calibration = Calibration.parse({
  model: JEV_MODEL,
  questionVersion: QUESTION_VERSION,
  createdAt: '2026-09-26T00:00:00.000Z',
  status: 'failed',
  golden: [],
  method: 'test fixture',
  grounding: { status: 'failed', criteria, gate: { minTop: 0.9, minGap: 0.5, maxNone: 0.1, noneMin: 0.5, rescueGap: null }, evidence: {} },
  claim: { status: 'failed', criteria, gate: { yes: 0.9, no: 0.1 }, evidence: {} },
  which: { status: 'failed', criteria, gate: { minTop: 0.9, minGap: 0.5, noneMin: 0.5 }, evidence: {} },
  commit: { status: 'failed', criteria: { maxConfidentWrong: 0, maxFalseAlarmRate: 0.2 }, gate: { risky: 0.5 }, evidence: {} },
  review: {
    status: 'calibrated',
    criteria: { maxConfidentWrong: 0, minGoodApproval: 0.5 },
    gate: { addressesMin: 0.8, unrelatedMax: 0.2, clarificationMax: 0.3 },
    evidence: {},
  },
});

/** Jev client whose transport answers every requested review Noul (unlisted ids → 0.9) without network. */
export function stubJev(answers: { addresses: number; unrelated: number; clarification: number }): { client: JevClient; requests: unknown[] } {
  const requests: unknown[] = [];
  const values: Record<string, number> = {
    addresses_requirement: answers.addresses,
    unrelated_steps: answers.unrelated,
    needs_clarification: answers.clarification,
  };
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
    requests.push(request);
    const replies = Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: 'noul', noul: values[id] ?? 0.9 }]));
    return new Response(JSON.stringify({ model: JEV_MODEL, answers: replies }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const client = new JevClient(loadJevConfig({ TYPESAFE_API_KEY: 'test-key-not-real' }), { fetchImpl });
  return { client, requests };
}
