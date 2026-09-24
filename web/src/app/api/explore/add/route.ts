import { NextRequest } from "next/server";
import { addOffersToPipeline } from "@/lib/core/pipeline";
import { careerOpsRoot } from "@/lib/career-ops";
import { readInboxSummary, inboxFate } from "@/lib/inbox-summary.mjs";
import type { DiscoveredOffer } from "@/lib/explore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Free + reversible: append chosen discovered offers to data/pipeline.md AND
// record them in data/scan-history.tsv, via the core's CANONICAL exported writers
// (no parallel writer). No tokens spent.
export async function POST(req: NextRequest) {
  let offers: DiscoveredOffer[] = [];
  try {
    const body = (await req.json()) as { offers?: DiscoveredOffer[] };
    offers = Array.isArray(body.offers) ? body.offers : [];
  } catch {
    return Response.json({ added: 0, error: "bad request" }, { status: 400 });
  }
  if (offers.length === 0) return Response.json({ added: 0 });

  const result = await addOffersToPipeline(offers);
  // "added" means the line was written, not that the Inbox shows it: the Inbox
  // hides a line whose seat the tracker already holds. So each offer also gets
  // its fate from the same composition the Inbox page uses: shown, or why not.
  const { inbox } = readInboxSummary(careerOpsRoot());
  const fates = offers.filter((o) => o && typeof o.url === "string").map((o) => inboxFate(inbox, o.url));
  return Response.json({ ...result, fates });
}
