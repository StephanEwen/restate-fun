import * as restate from "@restatedev/restate-sdk";

// The lifecycle of a single URL. A page starts (implicitly) "pending"; the first
// crawler to claim it flips it to "in-progress", then either "completed" or
// "failed". "failed" is terminal — we do not re-crawl pages that permanently
// failed (e.g. 404 / non-HTML).
export type Status = "pending" | "in-progress" | "completed" | "failed";

interface ClaimResult {
  /** true only when THIS caller transitioned the page pending -> in-progress. */
  proceed: boolean;
  /** the status the caller now observes. */
  status: Status;
}

// What `get` returns. The canonical URL is stored alongside the status so the
// object — which is keyed by an opaque hash — is easy to browse and query.
interface CrawlState {
  url: string | null;
  status: Status;
}

const STATUS_KEY = "status";
const URL_KEY = "url";

/**
 * Virtual Object keyed by the hash of a canonical URL. Because exclusive object
 * handlers run one-at-a-time per key, `tryClaim` is an atomic check-and-claim:
 * only one concurrent crawler can win the transition out of "pending". This is
 * what dedups work and breaks cycles in the crawl graph.
 */
export const crawlStatus = restate.object({
  name: "crawl-status",
  handlers: {
    tryClaim: async (
      ctx: restate.ObjectContext,
      url: string,
    ): Promise<ClaimResult> => {
      const current = (await ctx.get<Status>(STATUS_KEY)) ?? "pending";
      if (current === "pending") {
        // Record the URL behind this hash so the object is self-describing.
        ctx.set(URL_KEY, url);
        ctx.set(STATUS_KEY, "in-progress" as Status);
        return { proceed: true, status: "in-progress" };
      }
      return { proceed: false, status: current };
    },

    setStatus: async (
      ctx: restate.ObjectContext,
      status: "completed" | "failed",
    ): Promise<void> => {
      ctx.set(STATUS_KEY, status as Status);
    },

    // Read-only inspection — shared handlers may run concurrently with each other.
    get: restate.handlers.object.shared(
      { journalRetention: { days: 0 } }, // no need to keep history for this
      async (ctx: restate.ObjectSharedContext): Promise<CrawlState> => ({
        url: (await ctx.get<string>(URL_KEY)) ?? null,
        status: (await ctx.get<Status>(STATUS_KEY)) ?? "pending",
      }),
    ),
  }
});

export type CrawlStatus = typeof crawlStatus;
