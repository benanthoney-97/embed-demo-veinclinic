// app/api/jobs/ingest/route.ts
import { NextResponse } from "next/server";
export const runtime = "nodejs";

// --- deps
import { supabaseAdmin } from "@/lib/supabase";
import { Pinecone } from "@pinecone-database/pinecone";
import OpenAI from "openai";

// --- env
const SUPABASE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY!;
const PINECONE_INDEX = process.env.PINECONE_INDEX!;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small"; // 1536-dim, faster
const PINECONE_DIM = Number(process.env.PINECONE_DIM || 1536); // MUST match your index

// --- singletons
const pc = new Pinecone({ apiKey: PINECONE_API_KEY });
const index = pc.index(PINECONE_INDEX);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// --- route
export async function POST(req: Request) {
  const trace = getTraceId();
  const T0 = Date.now();

  try {
    const body = await req.json().catch((e) => {
      logErr("ingest", trace, "Invalid JSON", e);
      throw new Error("invalid json");
    });

    // Input
    const title: string | undefined = body.title;
    const requestedSlug: string | undefined = body.slug;
    const objectPath: string = body.objectPath; // required: storage key (can include bucket)
    let document_id: string | undefined = body.document_id;
    let doc_version_id: string | undefined = body.doc_version_id;

    if (!objectPath) {
      return NextResponse.json({ error: "objectPath required" }, { status: 400 });
    }

    // 0) Ensure env
    const missing: string[] = [];
    if (!SUPABASE_BUCKET) missing.push("SUPABASE_STORAGE_BUCKET");
    if (!OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
    if (!PINECONE_API_KEY) missing.push("PINECONE_API_KEY");
    if (!PINECONE_INDEX) missing.push("PINECONE_INDEX");
    if (missing.length) {
      const msg = `Missing env: ${missing.join(", ")}`;
      logErr("ingest", trace, msg);
      return NextResponse.json({ error: msg }, { status: 500 });
    }

    // 1) IDs & DB rows
    const T1 = Date.now();
    if (!document_id) document_id = cryptoRandomId();
    if (!doc_version_id) doc_version_id = cryptoRandomId();

    const page_slug =
      requestedSlug ||
      slugify(title || objectPath.split("/").slice(-1)[0] || "document") +
        "-" +
        document_id.slice(0, 8);

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

    // 2) Download bytes from Storage (normalize key to bucket-internal path)
    const T2 = Date.now();
    const pathInBucket = normalizeStoragePath(objectPath, SUPABASE_BUCKET);
    const dl = await supabaseAdmin.storage.from(SUPABASE_BUCKET).download(pathInBucket);
    if (dl.error || !dl.data) {
      const msg = `Download failed from bucket=${SUPABASE_BUCKET} key=${pathInBucket}: ${
        dl.error?.message || "unknown"
      }`;
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

// NEW: scrub invalid surrogate pairs / nulls before anything else
const sanitized = scrubUnicode(rawText);

// then normalize + chunk
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

    // 4) Embeddings (batched with retry)
    const T4 = Date.now();
    const vectors = await embedChunks(chunks, EMBEDDING_MODEL).catch((e) => {
      logErr("ingest", trace, "embedChunks failed", e);
      throw new Error("embedding failed");
    });

    // Dimension guard
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
  // Clean namespace if re-ingest of same version
  try {
    await index.namespace(namespace).deleteAll();
  } catch (e: any) {
    console.warn("[pinecone] deleteAll warning:", e?.message || e);
  }

  const records = vectors.map((v, i) => ({
    id: `${document_id}-${i}`,
    values: v.values, // number[]
    metadata: {
      document_id,
      doc_version_id,
      idx: i,
      path: v.path,
text_snippet: safeSnippet(v.snippet),
    } as Record<string, any>,
  }));

  for (const batch of chunkArray(records, 150)) {
    try {
      const resp = await index.namespace(namespace).upsert(batch);
      console.log("[pinecone] upsert batch ok:", resp);
    } catch (e: any) {
      console.error("[pinecone] upsert batch FAILED:", {
        message: e?.message,
        name: e?.name,
        status: e?.status,
        code: e?.code,
        stack: e?.stack,
        raw: e,
      });
      throw e;
    }
  }

  logLatency("ingest", trace, { step: "pinecone_upsert", ms: Date.now() - T5, upserted: records.length, namespace });
} catch (e: any) {
  await markFailed(document_id!, doc_version_id!, `pinecone upsert failed: ${e?.message || e}`);
  return NextResponse.json({ error: `pinecone upsert failed: ${e?.message || e}` }, { status: 500 });
}

    // 6) Optional: persist sections for editor/analytics (non-blocking warning only)
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
      if (ins.error) {
        logWarn("ingest", trace, "doc_sections insert warning", ins.error.message);
      }
    }

    // 7) Finalize
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
  } catch (e: any) {
    const msg = e?.message || String(e);
    console.error(`[ingest] trace=${trace} ERROR`, msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/* ---------------- helpers ---------------- */

function getTraceId() {
  // @ts-ignore
  return globalThis.crypto?.randomUUID?.() || String(Date.now());
}

function logLatency(scope: string, trace: string, data: Record<string, any>) {
  try {
    console.log(`[latency][${scope}] trace=${trace} ${JSON.stringify(data)}`);
  } catch {}
}

function logWarn(scope: string, trace: string, msg: string, detail?: any) {
  console.warn(`[warn][${scope}] trace=${trace} ${msg}${detail ? ` :: ${detail}` : ""}`);
}

function logErr(scope: string, trace: string, msg: string, err?: any) {
  console.error(`[error][${scope}] trace=${trace} ${msg}${err ? ` :: ${err?.message || err}` : ""}`);
}

function cryptoRandomId() {
  // @ts-ignore
  return globalThis.crypto?.randomUUID?.();
}

function guessExt(path: string) {
  const m = path?.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}

function normalizeStoragePath(objectPath: string, bucket: string) {
  // If the path starts with "<bucket>/" strip it, Supabase SDK expects bucket-internal key
  const re = new RegExp(`^${bucket}/`);
  return objectPath.replace(re, "");
}

function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

function normalizeText(t: string) {
  return sanitizeUnicode(
    t.normalize("NFC")
  );
}

// Nuke any surrogate halves and non-printable controls; keep \n \t \r
function scrubUnicode(s: string): string {
  if (!s) return "";
  // Remove ANY surrogate halves (D800–DFFF), i.e. unpaired or weird pairs
  s = s.replace(/[\uD800-\uDFFF]/g, "");
  // Strip C0/C1 controls except tab/newline/carriage-return
  s = s.replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g,
    ""
  );
  // Strip non-characters like U+FFFE/U+FFFF at any plane
  s = s.replace(/[\uFDD0-\uFDEF]/g, "");
  s = s.replace(/[\uFFFE\uFFFF]/g, "");
  // Collapse whitespace a bit
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

// Safe slice by code points (prevents cutting pairs)
function sliceByCodepoints(s: string, max: number): string {
  return Array.from(s).slice(0, max).join("");
}

// Helper that does both
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

async function embedChunks(chunks: ChunkUnit[], model: string) {
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
  let lastErr: any;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      const backoff = 400 * Math.pow(2, i) + Math.random() * 200;
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

async function extractText(ext: string, arrayBuf: ArrayBuffer): Promise<string> {
  if (ext === "pdf") {
    // --- Attempt A: pdf-parse (fast)
    try {
      const pdfParse = (await import("pdf-parse")).default as any;
      const data = await pdfParse(Buffer.from(arrayBuf));
      const textA = (data?.text || "").trim();
      console.log("[extractText] pdf-parse pages:", data?.numpages, "chars:", textA.length);
      if (textA.length > 20) return textA; // accept if we got a reasonable amount
    } catch (e: any) {
      console.warn("[extractText] pdf-parse failed, will try pdfjs-dist fallback:", e?.message || e);
    }

    // --- Attempt B: pdfjs-dist fallback (more compatible)
    try {
      // pdfjs-dist expects a Uint8Array
      const { getDocument } = await import("pdfjs-dist");
      // @ts-ignore - some installs expose .getDocument under .default
      const getDoc = (getDocument as any) || (await import("pdfjs-dist/legacy/build/pdf.js")).getDocument;

      const loadingTask = getDoc({ data: new Uint8Array(arrayBuf) });
      const pdf = await loadingTask.promise;

      let out = "";
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        // getTextContent gives structured text items
        const content = await page.getTextContent();
        const pageText = content.items
          .map((it: any) => (typeof it.str === "string" ? it.str : ""))
          .join(" ");
        out += (out ? "\n\n" : "") + pageText;
      }

      const textB = out.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      console.log("[extractText] pdfjs-dist pages:", pdf.numPages, "chars:", textB.length);
      return textB;
    } catch (e: any) {
      console.warn("[extractText] pdfjs-dist fallback failed:", e?.message || e);
      // fall through → try plain text
    }
  }

  if (ext === "docx") {
    try {
      const mammothMod: any = await import("mammoth");
      const { value } = await mammothMod.extractRawText({ buffer: Buffer.from(arrayBuf) });
      const txt = (value || "").trim();
      console.log("[extractText] mammoth docx chars:", txt.length);
      return txt;
    } catch (e: any) {
      console.warn("[extractText] mammoth failed:", e?.message || e);
    }
  }

  if (ext === "html" || ext === "htm") {
    const html = new TextDecoder("utf-8").decode(arrayBuf);
    const stripped = stripHtml(html).trim();
    console.log("[extractText] html chars:", stripped.length);
    return stripped;
  }

  try {
    const txt = new TextDecoder("utf-8").decode(arrayBuf).trim();
    console.log("[extractText] utf-8 plain chars:", txt.length);
    return txt;
  } catch {
    return "";
  }
}

// Remove unpaired surrogates, control chars (except \n\t\r), and non-characters (…FFFE/FFFF)
function sanitizeUnicode(input: string): string {
  let out = "";
  for (const ch of input) {             // iterates by code points
    const cp = ch.codePointAt(0)!;
    // skip unpaired surrogate halves (D800–DFFF are surrogates; valid pairs won't appear as single code points here)
    if (cp >= 0xD800 && cp <= 0xDFFF) continue;

    // strip C0/C1 controls except \t \n \r
    if (cp <= 0x1F && cp !== 0x09 && cp !== 0x0A && cp !== 0x0D) continue;
    if (cp >= 0x7F && cp <= 0x9F) continue;

    // strip non-characters like U+FFFE/U+FFFF at any plane
    if ((cp & 0xFFFF) === 0xFFFE || (cp & 0xFFFF) === 0xFFFF) continue;

    out += ch;
  }
  // normalize whitespace a bit
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Safe slicing by code points (so we never cut a surrogate pair)
function sliceCodepoints(input: string, maxChars: number): string {
  return Array.from(input).slice(0, maxChars).join("");
}

function stripHtml(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

async function markFailed(document_id: string, doc_version_id: string, error: string) {
  await supabaseAdmin.from("doc_versions").update({ status: "error" }).eq("id", doc_version_id);
  await supabaseAdmin.from("jobs").upsert({
    document_id,
    doc_version_id,
    type: "ingest",
    status: "failed",
    error,
    updated_at: new Date().toISOString(),
  });
}
