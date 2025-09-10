// app/api/jobs/ingest/route.ts
import { NextResponse } from "next/server";
export const runtime = "nodejs";

import { supabaseAdmin } from "@/lib/supabase";
import { Pinecone, type PineconeRecord, type RecordMetadata } from "@pinecone-database/pinecone";
import OpenAI from "openai";

/* ---------------- lazy singletons (no env at import time) ---------------- */

let _index: ReturnType<Pinecone["index"]> | null = null;
let _openai: OpenAI | null = null;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

function getOpenAI(): OpenAI {
  if (_openai) return _openai;
  _openai = new OpenAI({ apiKey: requireEnv("OPENAI_API_KEY") });
  return _openai;
}

function getPineconeIndex() {
  if (_index) return _index;
  const apiKey = requireEnv("PINECONE_API_KEY");
  const indexName = requireEnv("PINECONE_INDEX");
  const pc = new Pinecone({ apiKey });
  _index = pc.index(indexName);
  return _index;
}

/* ---------------- config helpers ---------------- */

function getConfig() {
  const SUPABASE_BUCKET = requireEnv("SUPABASE_STORAGE_BUCKET");
  const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
  const PINECONE_DIM = Number(process.env.PINECONE_DIM || 1536);
  return { SUPABASE_BUCKET, EMBEDDING_MODEL, PINECONE_DIM };
}

/* ---------------- route ---------------- */

export async function POST(req: Request) {
  const trace = getTraceId();
  const T0 = Date.now();

  try {
    // parse body
    const body = await req.json().catch((e) => {
      logErr("ingest", trace, "Invalid JSON", e);
      throw new Error("invalid json");
    });

    const title: string | undefined = body.title;
    const requestedSlug: string | undefined = body.slug;
    const objectPath: string = body.objectPath;
    let document_id: string | undefined = body.document_id;
    let doc_version_id: string | undefined = body.doc_version_id;

    if (!objectPath) {
      return NextResponse.json({ error: "objectPath required" }, { status: 400 });
    }

    // init config & clients (at request time)
    const { SUPABASE_BUCKET, EMBEDDING_MODEL, PINECONE_DIM } = getConfig();
    const index = getPineconeIndex();
    const openai = getOpenAI();

    // ids & rows
    const T1 = Date.now();
    if (!document_id) document_id = cryptoRandomId();
    if (!doc_version_id) doc_version_id = cryptoRandomId();

    const page_slug =
      requestedSlug ||
      slugify(title || objectPath.split("/").slice(-1)[0] || "document") + "-" + document_id.slice(0, 8);

    // upsert documents
    {
      const { error } = await supabaseAdmin.from("documents").upsert({
        id: document_id,
        title: title || objectPath.split("/").slice(-1)[0],
        slug: page_slug,
      });
      if (error) logWarn("ingest", trace, "documents upsert warning", error.message);
    }

    // insert/replace version (processing)
    {
      const { error } = await supabaseAdmin
        .from("doc_versions")
        .upsert({
          id: doc_version_id,
          document_id,
          status: "processing",
          source_uri: objectPath,
          version: 1,
        });
      if (error) logWarn("ingest", trace, "doc_versions upsert warning", error.message);
    }

    // share surface (point live_version to this version)
    {
      const { error } = await supabaseAdmin
        .from("share_surfaces")
        .upsert(
          {
            document_id,
            live_version_id: doc_version_id,
            page_slug,
            page_url: `/d/${page_slug}`,
            mode: "development",
            privacy: "private",
          },
          { onConflict: "document_id" }
        );
      if (error) logWarn("ingest", trace, "share_surfaces upsert warning", error.message);
    }

    logLatency("ingest", trace, {
      step: "init_rows",
      ms: Date.now() - T1,
      document_id,
      doc_version_id,
      page_slug,
    });

    // 2) Download bytes from Storage
    const T2 = Date.now();
    const pathInBucket = normalizeStoragePath(objectPath, SUPABASE_BUCKET);
    const dl = await supabaseAdmin.storage.from(SUPABASE_BUCKET).download(pathInBucket);
    if (dl.error || !dl.data) {
      const msg = `Download failed from bucket=${SUPABASE_BUCKET} key=${pathInBucket}: ${dl.error?.message || "unknown"}`;
      await markFailed(document_id, doc_version_id, msg);
      logErr("ingest", trace, msg);
      return NextResponse.json({ error: msg }, { status: 500 });
    }
    const arrayBuf = await dl.data.arrayBuffer();
    logLatency("ingest", trace, {
      step: "download",
      ms: Date.now() - T2,
      bucket: SUPABASE_BUCKET,
      key: pathInBucket,
      size_bytes: arrayBuf.byteLength,
    });

    // 3) Parse → clean → chunk
    const T3 = Date.now();
    const ext = guessExt(objectPath);
    const rawText = await extractText(ext, arrayBuf).catch((e) => {
      logErr("ingest", trace, `extractText(${ext}) failed`, e);
      return "";
    });
    if (!rawText) {
      const msg = "No text extracted (unsupported or empty)";
      await markFailed(document_id, doc_version_id, msg);
      logErr("ingest", trace, msg);
      return NextResponse.json({ error: msg }, { status: 400 });
    }

    const sanitized = scrubUnicode(rawText);
    const cleaned = normalizeText(sanitized);
    const chunks = smartChunk(cleaned);
    if (!chunks.length) {
      const msg = "No chunks produced";
      await markFailed(document_id, doc_version_id, msg);
      logErr("ingest", trace, msg);
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    logLatency("ingest", trace, {
      step: "parse_chunk",
      ms: Date.now() - T3,
      chars: cleaned.length,
      chunks: chunks.length,
      avg_chunk_chars: Math.round(cleaned.length / chunks.length),
    });

    // 4) Embeddings
    const T4 = Date.now();
    const vectors = await embedChunks(chunks, EMBEDDING_MODEL, openai).catch((e) => {
      logErr("ingest", trace, "embedChunks failed", e);
      throw new Error("embedding failed");
    });

    if (vectors.some((v) => v.values.length !== PINECONE_DIM)) {
      const msg = `Embedding dim ${vectors[0]?.values.length} != Pinecone index dim ${PINECONE_DIM}`;
      await markFailed(document_id, doc_version_id, msg);
      logErr("ingest", trace, msg);
      return NextResponse.json({ error: msg }, { status: 500 });
    }
    logLatency("ingest", trace, {
      step: "embed",
      ms: Date.now() - T4,
      vectors: vectors.length,
      model: EMBEDDING_MODEL,
    });

    // 5) Upsert to Pinecone
    const T5 = Date.now();
    const namespace = `doc:${document_id}:v:${doc_version_id}`;

    try {
      try {
        await index.namespace(namespace).deleteAll();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn("[pinecone] deleteAll warning:", msg);
      }

      type MetaValue = string | number | boolean;
      type Meta = Record<string, MetaValue>;
      const records: PineconeRecord<Meta>[] = vectors.map((v, i) => ({
        id: `${document_id}-${i}`,
        values: v.values,
        metadata: {
          document_id,
          doc_version_id,
          idx: i,
          path: v.path,
          text_snippet: safeSnippet(v.snippet),
        },
      }));

      for (const batch of chunkArray(records, 150)) {
        await index.namespace(namespace).upsert(batch as PineconeRecord<RecordMetadata>[]);
      }

      logLatency("ingest", trace, {
        step: "pinecone_upsert",
        ms: Date.now() - T5,
        upserted: records.length,
        namespace,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await markFailed(document_id!, doc_version_id!, `pinecone upsert failed: ${msg}`);
      return NextResponse.json({ error: `pinecone upsert failed: ${msg}` }, { status: 500 });
    }

    // 6) (non-blocking) persist sections
    {
      const ins = await supabaseAdmin.from("doc_sections").insert(
        chunks.map((c, i) => ({
          doc_version_id,
          idx: i,
          path: c.path,
          heading: c.heading ?? null,
          body: c.text,
        }))
      );
      if (ins.error) logWarn("ingest", trace, "doc_sections insert warning", ins.error.message);
    }

    // 7) finalize
    {
      const { error } = await supabaseAdmin.from("doc_versions").update({ status: "ready" }).eq("id", doc_version_id);
      if (error) logWarn("ingest", trace, "doc_versions update(ready) warning", error.message);
    }
    {
      const { error } = await supabaseAdmin.from("jobs").upsert({
        document_id,
        doc_version_id,
        type: "ingest",
        status: "succeeded",
        updated_at: new Date().toISOString(),
      });
      if (error) logWarn("ingest", trace, "jobs upsert warning", error.message);
    }

    logLatency("ingest", trace, { step: "total", ms: Date.now() - T0 });

    return NextResponse.json({
      ok: true,
      document_id,
      doc_version_id,
      page_slug,
      page_url: `/d/${page_slug}`,
      chunks: chunks.length,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[ingest] trace=${trace} ERROR`, msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

async function markFailed(document_id: string, doc_version_id: string, error: string) {
  try {
    await supabaseAdmin
      .from("doc_versions")
      .update({ status: "error" })
      .eq("id", doc_version_id);

    await supabaseAdmin.from("jobs").upsert({
      document_id,
      doc_version_id,
      type: "ingest",
      status: "failed",
      error,
      updated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[markFailed] failed to mark error:", e);
  }
}
/* ---------------- helpers (unchanged, with types) ---------------- */

function getTraceId() {
  try {
    return globalThis.crypto?.randomUUID?.() || String(Date.now());
  } catch {
    return String(Date.now());
  }
}
function logLatency(scope: string, trace: string, data: Record<string, unknown>) {
  try {
    console.log(`[latency][${scope}] trace=${trace} ${JSON.stringify(data)}`);
  } catch {}
}
function logWarn(scope: string, trace: string, msg: string, detail?: string) {
  console.warn(`[warn][${scope}] trace=${trace} ${msg}${detail ? ` :: ${detail}` : ""}`);
}
function logErr(scope: string, trace: string, msg: string, err?: unknown) {
  const d = err && (err as Error).message ? (err as Error).message : String(err ?? "");
  console.error(`[error][${scope}] trace=${trace} ${msg}${err ? ` :: ${d}` : ""}`);
}
function cryptoRandomId() {
  return globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
}
function guessExt(path: string) {
  const m = path?.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}
function normalizeStoragePath(objectPath: string, bucket: string) {
  const re = new RegExp(`^${bucket}/`);
  return objectPath.replace(re, "");
}
function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60);
}
function normalizeText(t: string) {
  return sanitizeUnicode(t.normalize("NFC"));
}
function scrubUnicode(s: string): string {
  if (!s) return "";
  s = s.replace(/[\uD800-\uDFFF]/g, "");
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
  s = s.replace(/[\uFDD0-\uFDEF]/g, "");
  s = s.replace(/[\uFFFE\uFFFF]/g, "");
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}
function sliceByCodepoints(s: string, max: number): string {
  return Array.from(s).slice(0, max).join("");
}
function safeSnippet(s: string, max = 500): string {
  return sliceByCodepoints(scrubUnicode(s), max);
}

type ChunkUnit = { text: string; path: string; heading?: string };
function smartChunk(text: string, maxChars = 1800, overlap = 200): ChunkUnit[] {
  const paras = text.replace(/\r\n/g, "\n").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out: ChunkUnit[] = [];
  let buf = "";
  const flush = () => {
    const s = buf.trim();
    if (!s) return;
    if (s.length > maxChars) {
      let start = 0;
      while (start < s.length) {
        const end = Math.min(start + maxChars, s.length);
        out.push({ text: s.slice(start, end), path: "root" });
        if (end === s.length) break;
        start = Math.max(0, end - overlap);
      }
    } else {
      out.push({ text: s, path: "root" });
    }
    buf = "";
  };
  for (const p of paras) {
    const candidate = buf ? `${buf}\n\n${p}` : p;
    if (candidate.length > maxChars) {
      flush();
      buf = p;
      if (buf.length > maxChars * 1.5) flush();
    } else {
      buf = candidate;
    }
  }
  flush();
  return out;
}
function chunkArray<T>(arr: T[], size: number) {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
async function embedChunks(
  chunks: ChunkUnit[],
  model: string,
  openai: OpenAI
): Promise<{ values: number[]; path: string; snippet: string }[]> {
  const inputs = chunks.map((c) => c.text);
  const batches = chunkArray(inputs, 96);
  const result: { values: number[]; path: string; snippet: string }[] = [];

  for (const b of batches) {
    const emb = await withRetry(() => openai.embeddings.create({ model, input: b }));
    const vecs = emb.data.map((d, i) => ({
      values: (d.embedding as unknown as number[]) || [],
      path: "root",
      snippet: b[i]!.slice(0, 500),
    }));
    result.push(...vecs);
  }
  return result;
}
async function withRetry<T>(fn: () => Promise<T>, tries = 4) {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const backoff = 400 * Math.pow(2, i) + Math.random() * 200;
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

/* ---- minimal pdf/docx/html extraction (typed) ---- */

type PDFGetDocument = (params: { data: Uint8Array }) => { promise: Promise<PDFDocumentProxy> };
interface PDFDocumentProxy { numPages: number; getPage(pageNumber: number): Promise<PDFPageProxy>; }
interface PDFPageProxy { getTextContent(): Promise<TextContent>; }
interface TextItem { str?: string }
interface TextContent { items: Array<TextItem | unknown> }
function isTextItem(x: unknown): x is TextItem {
  return typeof x === "object" && x !== null && "str" in (x as Record<string, unknown>);
}
type MammothModule = { extractRawText: (input: { buffer: Buffer }) => Promise<{ value?: string }> };

async function extractText(ext: string, arrayBuf: ArrayBuffer): Promise<string> {
  if (ext === "pdf") {
    try {
      const mod = (await import("pdf-parse")).default as unknown as (
        input: Buffer
      ) => Promise<{ text?: string; numpages?: number }>;
      const data = await mod(Buffer.from(arrayBuf));
      const textA = (data?.text ?? "").trim();
      if (textA.length > 20) return textA;
    } catch (e) {
      console.warn("[extractText] pdf-parse failed:", e instanceof Error ? e.message : String(e));
    }
    try {
      const pdfjs = (await import("pdfjs-dist")) as unknown as {
        getDocument?: PDFGetDocument;
        default?: { getDocument?: PDFGetDocument };
      };
      const getDocument: PDFGetDocument | undefined = pdfjs.getDocument ?? pdfjs.default?.getDocument;
      if (!getDocument) throw new Error("pdfjs-dist getDocument not found");

      const loadingTask = getDocument({ data: new Uint8Array(arrayBuf) });
      const pdf: PDFDocumentProxy = await loadingTask.promise;

      let out = "";
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const content = await page.getTextContent();
        const pageText = content.items.map((it) => (isTextItem(it) ? it.str ?? "" : "")).join(" ");
        out += (out ? "\n\n" : "") + pageText;
      }
      return out.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    } catch (e) {
      console.warn("[extractText] pdfjs-dist failed:", e instanceof Error ? e.message : String(e));
    }
  }

  if (ext === "docx") {
    try {
      const mammothMod = (await import("mammoth")) as unknown as MammothModule;
      const { value } = await mammothMod.extractRawText({ buffer: Buffer.from(arrayBuf) });
      return (value ?? "").trim();
    } catch (e) {
      console.warn("[extractText] mammoth failed:", e instanceof Error ? e.message : String(e));
    }
  }

  if (ext === "html" || ext === "htm") {
    const html = new TextDecoder("utf-8").decode(arrayBuf);
    return stripHtml(html).trim();
  }

  try {
    return new TextDecoder("utf-8").decode(arrayBuf).trim();
  } catch {
    return "";
  }
}
function sanitizeUnicode(input: string): string {
  let out = "";
  for (const ch of input) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xD800 && cp <= 0xDFFF) continue;
    if (cp <= 0x1F && cp !== 0x09 && cp !== 0x0A && cp !== 0x0D) continue;
    if (cp >= 0x7F && cp <= 0x9F) continue;
    if ((cp & 0xffff) === 0xfffe || (cp & 0xffff) === 0xffff) continue;
    out += ch;
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
function stripHtml(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}