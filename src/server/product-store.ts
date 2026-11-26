import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative } from 'node:path';
import { stringify } from 'yaml';
import { z } from 'zod';
import { ensureDir, sha256, writeAtomic } from '../core/fsx.ts';
import { acquireFileLock, FileLockedError } from '../core/lock.ts';
import type { Platform } from '../core/types.ts';
import {
  PRODUCT_SUPPORT, ProductDocument, ProductMutation, ProductSnapshot, ProductSettings,
  ProductSourceManifest, productDigest, scenarioSourceDigest, sourceQualificationProblems,
  SCENARIO_NOTES_DOCUMENT_ID, SourceLedger, textSourceLedger, unsupportedSourceLedger,
  type ProductMutationKind, type ProductReviewer, type SourceIngestor,
} from '../core/product.ts';
import { loadAppProfile } from '../spec/load.ts';
import { profilePlatforms, TestSpec } from '../spec/schema.ts';

export { ProductSettings } from '../core/product.ts';
export type { ProductSnapshot, ProductMutationKind } from '../core/product.ts';

const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const MAX_MUTATION_BYTES = 2 * 1024 * 1024;
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;

export class ProductStoreError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function emptySnapshot(): ProductSnapshot {
  return {
    schema: 'qautra/workspace/v2', revision: 0, scenarios: [], documents: [], environments: [],
    settings: { frontendURL: '', apiURL: '', webLimit: 1, androidLimit: 1, iosLimit: 1, totalLimit: 1,
      retentionDays: 7, codexEnabled: true, claudeEnabled: true },
    support: PRODUCT_SUPPORT, legacyCatalogPath: null,
  };
}

function inside(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel !== '' && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function boundedFile(file: string, root: string, maximum = MAX_DOCUMENT_BYTES): Promise<{ path: string; bytes: Buffer }> {
  const confinedRoot = await realpath(root);
  const path = await realpath(file);
  if (!inside(confinedRoot, path)) throw new Error('outside allowed directory');
  const parentPath = dirname(path);
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const rootHandle = await open(confinedRoot, flags | constants.O_DIRECTORY);
  try {
    const rootInfo = await rootHandle.stat({ bigint: true });
    const parentHandle = await open(parentPath, flags | constants.O_DIRECTORY);
    try {
      const parentInfo = await parentHandle.stat({ bigint: true });
      const sameIdentity = (first: typeof rootInfo, second: typeof rootInfo) => first.dev === second.dev && first.ino === second.ino;
      const checkBoundary = async () => {
        if (!rootInfo.isDirectory() || !parentInfo.isDirectory() || await realpath(root) !== confinedRoot
            || await realpath(file) !== path || !inside(confinedRoot, path)
            || !sameIdentity(rootInfo, await rootHandle.stat({ bigint: true }))
            || !sameIdentity(rootInfo, await lstat(confinedRoot, { bigint: true }))
            || !sameIdentity(parentInfo, await parentHandle.stat({ bigint: true }))
            || !sameIdentity(parentInfo, await lstat(parentPath, { bigint: true }))) {
          throw new Error('document boundary changed');
        }
      };
      await checkBoundary();
      const expected = await lstat(path, { bigint: true });
      const handle = await open(path, flags);
      try {
        const before = await handle.stat({ bigint: true });
        const sameVersion = (current: typeof before) => current.isFile() && sameIdentity(before, current)
          && before.size === current.size && before.mtimeNs === current.mtimeNs && before.ctimeNs === current.ctimeNs;
        if (!before.isFile() || before.size > BigInt(maximum)) throw new Error('document byte limit or nonregular file');
        if (!sameVersion(expected) || !sameVersion(await lstat(path, { bigint: true }))) throw new Error('document changed while opening');
        await checkBoundary();
        const bytes = Buffer.allocUnsafe(Number(before.size) + 1);
        let length = 0;
        while (length < bytes.length) {
          const result = await handle.read(bytes, length, bytes.length - length, null);
          if (!result.bytesRead) break;
          length += result.bytesRead;
        }
        if (length !== Number(before.size) || !sameVersion(await handle.stat({ bigint: true }))
            || !sameVersion(await lstat(path, { bigint: true }))) throw new Error('document changed or exceeds byte limit');
        await checkBoundary();
        return { path, bytes: bytes.subarray(0, length) };
      } finally { await handle.close(); }
    } finally { await parentHandle.close(); }
  } finally { await rootHandle.close(); }
}

function catalogText(state: ProductSnapshot): string {
  const text = `${JSON.stringify(ProductSnapshot.parse(state), null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_CATALOG_BYTES) throw new ProductStoreError(413, '작업 공간 catalog의 16 MiB 한도를 초과합니다. 기존 기록과 원본은 보존되며 이번 변경은 저장하지 않았습니다.');
  return text;
}

function documentCatalogBytes(document: ProductDocument): number {
  const text = JSON.stringify(document, null, 2);
  let bytes = Buffer.byteLength(text) + 6;
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) bytes += 4;
  return bytes;
}

const LegacySnapshot = z.object({
  schema: z.literal('qautra/workspace/v1'), revision: z.number().int().min(0),
  scenarios: z.array(z.object({ id: z.string().uuid(), name: z.string(), app: z.string(),
    platforms: TestSpec.shape.platforms.unwrap(), createdAt: z.iso.datetime(), path: z.string(),
    expected: z.string(), requirementID: z.string().nullable() }).passthrough()),
  documents: z.array(z.object({ id: z.string().uuid(), name: z.string(), path: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.iso.datetime() }).passthrough()),
  environments: ProductSnapshot.shape.environments, settings: ProductSettings,
}).passthrough();

export class ProductStore {
  private readonly directory: string;
  private readonly file: string;
  private readonly legacyFile: string;
  private readonly paths: { root: string; apps: string; uploads: string; generated: string };
  private readonly ingestSource?: SourceIngestor;

  constructor(paths: { root: string; apps: string; uploads: string; generated: string }, options: { ingestSource?: SourceIngestor } = {}) {
    this.paths = paths;
    this.directory = join(paths.root, '.qa', 'product');
    this.file = join(this.directory, 'catalog-v2.json');
    this.legacyFile = join(this.directory, 'catalog.json');
    this.ingestSource = options.ingestSource;
  }

  async read(): Promise<ProductSnapshot> {
    const readCatalog = async (path: string) => {
      let found = false;
      try {
        await lstat(path);
        found = true;
        const { bytes } = await boundedFile(path, this.directory, MAX_CATALOG_BYTES);
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch (error) {
        if (!found && missing(error)) throw error;
        throw new ProductStoreError(500, '작업 공간 catalog를 안전하게 읽지 못했습니다. 16 MiB 이하의 정상 UTF-8 일반 파일인지 확인하고, 기존 catalog와 원본을 보존한 채 복구하세요.');
      }
    };
    let text: string;
    try { text = await readCatalog(this.file); }
    catch (error) {
      if (!missing(error)) throw error;
      try { text = await readCatalog(this.legacyFile); }
      catch (legacyError) { if (missing(legacyError)) return emptySnapshot(); throw legacyError; }
    }
    let json: unknown;
    try { json = JSON.parse(text); }
    catch { throw new ProductStoreError(500, '작업 공간 기록이 손상되었습니다. 원본 catalog를 보존하고 복구하세요.'); }
    const parsed = ProductSnapshot.safeParse(json);
    if (parsed.success) return parsed.data;
    const legacy = LegacySnapshot.safeParse(json);
    if (!legacy.success) throw new ProductStoreError(500, '지원하지 않거나 손상된 작업 공간 형식입니다. 원본을 보존하고 복구하세요.');
    const state = emptySnapshot();
    state.revision = legacy.data.revision;
    state.legacyCatalogPath = this.legacyFile;
    state.environments = legacy.data.environments;
    state.settings = { ...legacy.data.settings, webLimit: 1, androidLimit: 1, iosLimit: 1, totalLimit: 1 };
    state.scenarios = legacy.data.scenarios.map(row => ({
      id: row.id, name: row.name, app: row.app, platforms: row.platforms, createdAt: row.createdAt, path: row.path,
      definition: null, source: null, executable: false, review: null, digest: null, manifestPath: null, legacy: row,
      problems: [{ code: 'legacy_read_only', locator: row.path, message: '과거 원본입니다. 새 초안으로 변환·검토한 뒤 발행하세요. 과거 approved는 승계되지 않습니다.' }],
    }));
    state.documents = legacy.data.documents.map(row => {
      const ledger = unsupportedSourceLedger('과거 문서 연결입니다. 원본을 새 문서로 가져와 구간을 검토하세요.');
      return { id: row.id, name: row.name, path: row.path, sha256: row.sha256, createdAt: row.createdAt,
        originalPath: row.path, ...ledger, ledgerDigest: productDigest(ledger) };
    });
    return state;
  }

  private async document(id: string, name: string, path: string, originalPath: string, bytes: Buffer, createdAt: string, text?: string): Promise<ProductDocument> {
    let ledger: SourceLedger;
    try {
      ledger = SourceLedger.parse(text !== undefined ? textSourceLedger(text)
        : this.ingestSource ? await this.ingestSource(bytes, originalPath)
          : ['.txt', '.md', '.markdown'].includes(extname(originalPath).toLowerCase())
            ? textSourceLedger(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
            : unsupportedSourceLedger('이 문서 형식의 구간 parser가 연결되지 않았습니다. 원본은 보존되었습니다.'));
    } catch { ledger = unsupportedSourceLedger('문서를 해석하지 못했습니다. 원본 bytes와 위치를 보존했습니다.'); }
    if (Buffer.byteLength(JSON.stringify(ledger)) > MAX_CATALOG_BYTES) ledger = unsupportedSourceLedger('추출한 원문 구간이 지원 byte 한도를 초과했습니다.');
    return ProductDocument.parse({ id, name, path, originalPath, sha256: sha256(bytes), createdAt,
      ...ledger, ledgerDigest: productDigest(ledger) });
  }

  async update(kind: ProductMutationKind, raw: unknown, context: { reviewer?: ProductReviewer } = {}): Promise<ProductSnapshot> {
    let size: number;
    try { size = Buffer.byteLength(JSON.stringify(raw)); }
    catch { throw new ProductStoreError(400, '직렬화 가능한 입력만 저장할 수 있습니다.'); }
    if (size > MAX_MUTATION_BYTES) throw new ProductStoreError(413, '입력 byte 한도를 초과했습니다.');
    const parsed = ProductMutation.safeParse({ kind, body: raw });
    if (!parsed.success) throw new ProductStoreError(400, '입력 형식이 올바르지 않습니다. 실제 단계 정의와 원문 연결을 확인하세요.');
    const mutation = parsed.data;
    if (mutation.kind === 'scenarios' && mutation.body.source.reviewed &&
      (!context.reviewer || context.reviewer.channel !== 'local-ui' || !context.reviewer.principalId.trim())) {
      throw new ProductStoreError(403, '현재 정의와 원문 검토는 신뢰된 로컬 QA 화면에서만 확인할 수 있습니다.');
    }
    if (mutation.kind === 'settings' && [mutation.body.settings.webLimit, mutation.body.settings.androidLimit,
      mutation.body.settings.iosLimit, mutation.body.settings.totalLimit].some(limit => limit !== 1)) {
      throw new ProductStoreError(400, '현재 지원하는 활성 흐름 상한은 로컬 사용자 전체 1입니다. 더 높은 동시 상한은 지원하지 않습니다.');
    }
    ensureDir(this.directory);
    let lock;
    try { lock = acquireFileLock(join(this.directory, 'catalog.lock'), { purpose: 'QAutra 작업 공간 저장' }); }
    catch (error) {
      if (error instanceof FileLockedError) throw new ProductStoreError(409, '다른 요청이 저장 중입니다. 새로고침한 뒤 다시 확인하세요.');
      throw error;
    }
    try {
      const state = await this.read();
      if (state.revision !== mutation.body.revision) throw new ProductStoreError(409, '작업 공간이 변경되었습니다. 새로고침한 뒤 변경 내용을 다시 확인하세요.');
      const createdAt = new Date().toISOString();
      const artifacts: { path: string; bytes: string | Buffer }[] = [];
      switch (mutation.kind) {
        case 'scenarios': {
          const previous = mutation.body.id ? state.scenarios.find(row => row.id === mutation.body.id) : undefined;
          if (mutation.body.id && !previous) throw new ProductStoreError(404, '수정할 시나리오가 없습니다.');
          if (previous?.legacy) throw new ProductStoreError(409, '과거 시나리오는 읽기 전용입니다. 원본을 유지하고 새 초안으로 저장하세요.');
          if (!previous && state.scenarios.length >= 5000) throw new ProductStoreError(409, '시나리오 등록 상한에 도달했습니다.');
          const id = previous?.id ?? randomUUID();
          const definition = mutation.body.definition;
          if (definition.source) throw new ProductStoreError(400, '원문 manifest와 검토 상태는 저장 서버가 생성합니다. 기존 approved 값을 입력할 수 없습니다.');
          let supported: Platform[];
          try { supported = profilePlatforms(loadAppProfile(definition.app, this.paths.apps)); }
          catch { throw new ProductStoreError(400, '실제 앱 프로필을 먼저 등록하고 선택하세요.'); }
          const platforms = definition.platforms ?? supported;
          if (new Set(platforms).size !== platforms.length || platforms.some(platform => !supported.includes(platform))) throw new ProductStoreError(400, '앱 프로필이 지원하는 환경만 한 번씩 선택하세요.');
          const source = mutation.body.source;
          const documents = state.documents.filter(doc => source.documentIDs.includes(doc.id));
          for (const doc of documents) {
            try {
              const actual = await boundedFile(doc.path, doc.path.startsWith(join(this.directory, 'sources') + '/') ? join(this.directory, 'sources') : this.paths.uploads);
              if (sha256(actual.bytes) !== doc.sha256) throw new Error('source digest changed');
              if (doc.derivation) {
                const parent = await boundedFile(doc.derivation.path, join(this.directory, 'sources'));
                if (sha256(parent.bytes) !== doc.derivation.sha256) throw new Error('parent source digest changed');
              }
            } catch { throw new ProductStoreError(409, '연결한 원문 bytes가 변경되었거나 사라졌습니다. 다시 가져와 검토하세요.'); }
          }
          if (source.notes.trim()) {
            const bytes = Buffer.from(source.notes, 'utf8');
            const path = join(this.directory, 'sources', `${sha256(bytes)}.notes.txt`);
            artifacts.push({ path, bytes });
            const ledger = textSourceLedger(source.notes);
            documents.push(ProductDocument.parse({ id: SCENARIO_NOTES_DOCUMENT_ID, name: '시나리오 수동 원문', path,
              originalPath: 'manual:scenario-notes', sha256: sha256(bytes), createdAt: previous?.createdAt ?? createdAt,
              ...ledger, ledgerDigest: productDigest(ledger) }));
            if (!source.documentIDs.includes(SCENARIO_NOTES_DOCUMENT_ID)) source.documentIDs.push(SCENARIO_NOTES_DOCUMENT_ID);
          }
          const problems = sourceQualificationProblems(definition, source, documents);
          const digest = scenarioSourceDigest(definition, source, documents);
          const review = source.reviewed && context.reviewer ? { ...context.reviewer, digest, reviewedAt: createdAt } : null;
          if (!review) problems.push({ code: 'source_review_required', locator: 'source', message: '현재 정의와 원문을 검토하세요. 수정 전 검토는 승계되지 않습니다.' });
          const artifactID = `${digest}.${sha256(JSON.stringify({ review, createdAt })).slice(0, 16)}`;
          const manifestPath = join(this.directory, 'scenarios', id, `${artifactID}.source.json`);
          const manifest = ProductSourceManifest.parse({ schema: 'qautra/scenario-source/v2', scenarioID: id, createdAt,
            definition, source, documents, digest, review, problems });
          const path = join(this.directory, 'scenarios', id, `${artifactID}.e2e.yaml`);
          artifacts.push({ path: manifestPath, bytes: `${JSON.stringify(manifest, null, 2)}\n` },
            { path, bytes: stringify({ ...definition, source: { plan: manifestPath, status: 'draft' } }) });
          const row = { id, name: definition.name, app: definition.app, platforms, createdAt: previous?.createdAt ?? createdAt,
            path, definition, source, executable: problems.length === 0, problems, review, digest, manifestPath, legacy: null };
          if (previous) state.scenarios[state.scenarios.indexOf(previous)] = row;
          else state.scenarios.push(row);
          break;
        }
        case 'documents': {
          if (state.documents.length >= 5000) throw new ProductStoreError(409, '문서 등록 상한에 도달했습니다.');
          const id = randomUUID();
          let bytes: Buffer;
          let originalPath: string;
          let extension: string;
          if (mutation.body.text !== undefined) {
            bytes = Buffer.from(mutation.body.text, 'utf8'); originalPath = `manual:${id}`; extension = '.txt';
          } else {
            try {
              const upload = await boundedFile(mutation.body.path!, this.paths.uploads);
              bytes = upload.bytes; originalPath = upload.path; extension = extname(originalPath).toLowerCase();
            } catch { throw new ProductStoreError(400, '이 엔진에 실제 업로드한 byte 한도 이내의 문서만 연결할 수 있습니다.'); }
          }
          const path = join(this.directory, 'sources', `${id}${extension.replace(/[^.a-z0-9]/g, '')}`);
          const doc = await this.document(id, mutation.body.name, path, originalPath, bytes, createdAt, mutation.body.text);
          artifacts.push({ path, bytes });
          state.documents.push(doc);
          break;
        }
        case 'document-rows': {
          const parent = state.documents.find(doc => doc.id === mutation.body.documentID);
          if (!parent) throw new ProductStoreError(404, '분리할 원문 문서를 찾을 수 없습니다.');
          if (!this.ingestSource || parent.derivation || parent.issues.length || !parent.jsonRows?.length) throw new ProductStoreError(400, '정상 JSON 배열의 모든 항목이 객체인 원문만 객체행별로 분리할 수 있습니다. 미확인·혼합·잘린 입력을 일부만 가져오지 않습니다.');
          if (state.documents.some(doc => doc.derivation?.documentID === parent.id)) throw new ProductStoreError(409, '이 원본은 이미 객체행 원문으로 분리됐습니다. 최신 문서 목록을 조회하세요. 중복 분리하지 않습니다.');
          if (state.documents.length + parent.jsonRows.length > 5000) throw new ProductStoreError(409, '전체 객체행을 보존할 문서 등록 여유가 없습니다. 일부 행만 분리하지 않습니다.');
          let original: { path: string; bytes: Buffer };
          try { original = await boundedFile(parent.path, join(this.directory, 'sources')); }
          catch { throw new ProductStoreError(409, '분리 전 원문 bytes와 저장 경계를 확인하지 못했습니다.'); }
          if (sha256(original.bytes) !== parent.sha256) throw new ProductStoreError(409, '분리 전 원문 bytes가 변경됐습니다. 다시 가져와 검토하세요.');
          const ledger = SourceLedger.parse(await this.ingestSource(original.bytes, parent.originalPath));
          if (ledger.issues.length || !ledger.jsonRows?.length || productDigest(ledger) !== parent.ledgerDigest) throw new ProductStoreError(409, '분리 전 원문 구조·구간 위치가 등록 기록과 다릅니다. 원본을 다시 연결하세요.');
          const rows: { document: ProductDocument; bytes: Buffer }[] = [];
          let catalogBytes = Buffer.byteLength(catalogText(state));
          for (const row of ledger.jsonRows) {
            const id = randomUUID();
            const bytes = original.bytes.subarray(row.startByte, row.endByte);
            const path = join(this.directory, 'sources', `${id}.json`);
            const document = await this.document(id, `${parent.name.slice(0, 170)} · 객체행 ${row.index + 1}`, path, `json-row:${parent.id}/${row.index}.json`, bytes, createdAt);
            if (document.issues.length) throw new ProductStoreError(409, '객체행의 원문 분석이 완료되지 않았습니다. 전체 분리를 저장하지 않습니다.');
            document.derivation = {
              kind: 'qautra/json-object-row/v1', documentID: parent.id, name: parent.name, path: parent.path,
              sha256: parent.sha256, ledgerDigest: parent.ledgerDigest, rowCount: ledger.jsonRows.length, row,
            };
            rows.push({ document, bytes });
            catalogBytes += documentCatalogBytes(document);
            if (catalogBytes > MAX_CATALOG_BYTES) throw new ProductStoreError(413, '전체 객체행을 보존하면 catalog의 16 MiB 한도를 초과합니다. 일부 행이나 새 원본 파일을 저장하지 않았습니다.');
          }
          for (const row of rows) artifacts.push({ path: row.document.path, bytes: row.bytes });
          state.documents.push(...rows.map(row => row.document));
          break;
        }
        case 'environments': {
          if (state.environments.length >= 5000) throw new ProductStoreError(409, '환경 등록 상한에 도달했습니다.');
          const { name, platform, deviceID } = mutation.body;
          if (state.environments.some(environment => environment.name === name && environment.platform === platform)) throw new ProductStoreError(409, '같은 이름과 플랫폼의 환경이 있습니다.');
          state.environments.push({ id: randomUUID(), name, platform, deviceID: deviceID ?? null, createdAt });
          break;
        }
        case 'settings': state.settings = mutation.body.settings; break;
      }
      state.revision++;
      const text = catalogText(state);
      for (const artifact of artifacts) writeAtomic(artifact.path, artifact.bytes);
      writeAtomic(this.file, text);
      return state;
    } finally { lock.release(); }
  }
}
