import { NextRequest } from "next/server";
import { careerOpsRoot } from "@/lib/career-ops";
import { atomicWrite } from "@/lib/core/safe-write";
import { cleanUrlList } from "@/lib/inbox-hidden.mjs";
import { readHiddenFile, updateHiddenFile } from "@/lib/inbox-hidden-file.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The rows hidden with X on the Inbox, kept in data/inbox-hidden.tsv so every
// browser, /api/pipeline and `node inbox-summary.mjs` leave out the same rows
// (see inbox-hidden.mjs). pipeline.md is never written here.

export async function GET() {
  try {
    const entries = readHiddenFile(careerOpsRoot());
    return Response.json({ urls: entries.map((e) => e.url), count: entries.length });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

// Body: { add?: string[], remove?: string[] }. An X adds one URL, undo and
// restore remove, and the page's one-time move of the browser's old list adds
// many. Answers with the whole list and its count.
export async function POST(req: NextRequest) {
  let body: { add?: unknown; remove?: unknown };
  try {
    body = (await req.json()) as { add?: unknown; remove?: unknown };
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  if (!body || typeof body !== "object") return Response.json({ error: "bad request" }, { status: 400 });
  try {
    const { entries, added, removed } = updateHiddenFile(
      careerOpsRoot(),
      { add: cleanUrlList(body.add), remove: cleanUrlList(body.remove) },
      { write: atomicWrite },
    );
    return Response.json({ urls: entries.map((e) => e.url), count: entries.length, added, removed });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
