import { z } from "zod";
import { prUrl, summarizeChecks, type Pr, type PrRef } from "../shared/prs";

// The same fields `gh pr list --json ...statusCheckRollup` reads, for PRs picked by number.
const PR_FIELDS = `number title url state isDraft reviewDecision
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
    ... on CheckRun { status conclusion }
    ... on StatusContext { state }
  } } } } } }`;

/** One query for every ref: a `repository` alias per repo, a `pullRequest` alias per number. */
export function linkedPrsQuery(refs: readonly PrRef[]): { query: string; aliases: Map<string, PrRef> } {
  const byRepo = new Map<string, Set<number>>();
  for (const ref of refs) byRepo.set(ref.repo, (byRepo.get(ref.repo) ?? new Set()).add(ref.number));
  const aliases = new Map<string, PrRef>();
  const blocks = [...byRepo].map(([repo, numbers], index) => {
    const [owner, name] = repo.split("/");
    const prs = [...numbers].map((number) => {
      aliases.set(`r${index}.p${number}`, { repo, number });
      return `p${number}: pullRequest(number: ${number}) { ${PR_FIELDS} }`;
    });
    return `r${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${prs.join(" ")} }`;
  });
  return { query: `query { ${blocks.join(" ")} }`, aliases };
}

const NodeSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  isDraft: z.boolean(),
  reviewDecision: z.string().nullish(),
  commits: z
    .object({
      nodes: z.array(
        z.object({
          commit: z.object({ statusCheckRollup: z.object({ contexts: z.object({ nodes: z.array(z.unknown()) }) }).nullish() }),
        }),
      ),
    })
    .nullish(),
});

const REVIEWS: Record<string, Pr["review"]> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  REVIEW_REQUIRED: "review_required",
};

/** PRs by `prUrl(ref)` from the response to `linkedPrsQuery`; missing or malformed ones are left out. */
export function parseLinkedPrs(json: string, aliases: ReadonlyMap<string, PrRef>): Map<string, Pr> {
  const data = (JSON.parse(json) as { data?: Record<string, Record<string, unknown> | null> | null }).data ?? {};
  const prs = new Map<string, Pr>();
  for (const [alias, ref] of aliases) {
    const [repoAlias, prAlias] = alias.split(".") as [string, string];
    const node = NodeSchema.safeParse(data[repoAlias]?.[prAlias]);
    if (!node.success) continue;
    const pr = node.data;
    prs.set(prUrl(ref), {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      draft: pr.isDraft,
      review: REVIEWS[pr.reviewDecision ?? ""] ?? "none",
      ...summarizeChecks(pr.commits?.nodes[0]?.commit.statusCheckRollup?.contexts.nodes),
    });
  }
  return prs;
}
