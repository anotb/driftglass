import type { Env, NormalizedItemInput, SourceAdapterResult, SourceRecord } from "../types";
import { fetchWithTimeout, normalizeStringArray, numberFrom, parseJson, readBoundedResponseJson } from "../utils";
import { githubRepositoryApiUrl, normalizeGithubRepositories } from "./github-config";
import { discardRemoteSourceResponse, settleRemoteSourceRequests } from "./remote-runtime";

const MAX_GITHUB_EVENTS_RESPONSE_BYTES = 4_000_000;

interface GithubActivityConfig {
  repos?: string[];
  perRepo?: number;
  includeTypes?: string[];
  watchTerms?: string[];
}

interface GithubEvent {
  id: string;
  type: string;
  created_at: string;
  actor?: { login?: string };
  repo?: { name?: string };
  payload?: Record<string, any>;
}

function eventItem(
  repo: string,
  event: GithubEvent,
  watchTerms: string[],
  accessClass: "public" | "private",
): NormalizedItemInput | null {
  const payload = event.payload ?? {};
  const actor = event.actor?.login;
  const base = `https://github.com/${repo}`;
  let title = `${repo}: ${event.type}`;
  let text = "";
  let url = base;
  let action = String(payload.action ?? "");

  if (event.type === "PullRequestEvent" && payload.pull_request) {
    const pr = payload.pull_request;
    title = `${repo}: ${action || "updated"} PR #${pr.number} — ${pr.title}`;
    text = String(pr.body ?? "");
    url = String(pr.html_url ?? base);
  } else if (event.type === "IssuesEvent" && payload.issue) {
    const issue = payload.issue;
    title = `${repo}: ${action || "updated"} issue #${issue.number} — ${issue.title}`;
    text = String(issue.body ?? "");
    url = String(issue.html_url ?? base);
  } else if (event.type === "IssueCommentEvent" && payload.issue) {
    const issue = payload.issue;
    title = `${repo}: new comment on #${issue.number} — ${issue.title}`;
    text = String(payload.comment?.body ?? "");
    url = String(payload.comment?.html_url ?? issue.html_url ?? base);
  } else if (event.type === "PushEvent") {
    const commits = Array.isArray(payload.commits) ? payload.commits : [];
    const ref = String(payload.ref ?? "").replace("refs/heads/", "");
    title = `${repo}: ${commits.length || payload.size || 0} commit${commits.length === 1 ? "" : "s"} pushed${ref ? ` to ${ref}` : ""}`;
    text = commits.slice(0, 20).map((commit: Record<string, unknown>) => `${String(commit.sha ?? "").slice(0, 8)} ${String(commit.message ?? "")}`).join("\n");
    url = payload.head ? `${base}/commit/${payload.head}` : `${base}/commits/${encodeURIComponent(ref || "HEAD")}`;
  } else if (event.type === "ReleaseEvent" && payload.release) {
    const release = payload.release;
    title = `${repo}: released ${release.name || release.tag_name}`;
    text = String(release.body ?? "");
    url = String(release.html_url ?? base);
  } else if (event.type === "CreateEvent") {
    title = `${repo}: created ${payload.ref_type || "reference"}${payload.ref ? ` ${payload.ref}` : ""}`;
    text = String(payload.description ?? "");
  } else if (event.type === "ForkEvent" && payload.forkee) {
    title = `${repo}: forked to ${payload.forkee.full_name || "a new repository"}`;
    url = String(payload.forkee.html_url ?? base);
  } else if (event.type === "WatchEvent") {
    title = `${repo}: starred by ${actor || "a GitHub user"}`;
    action = "starred";
  } else if (event.type === "PullRequestReviewEvent" && payload.pull_request) {
    const pr = payload.pull_request;
    title = `${repo}: ${action || "reviewed"} PR #${pr.number} — ${pr.title}`;
    text = String(payload.review?.body ?? "");
    url = String(payload.review?.html_url ?? pr.html_url ?? base);
  }

  return {
    externalId: `${repo}:event:${event.id}`,
    url,
    title,
    text,
    author: actor,
    publishedAt: event.created_at,
    accessClass,
    metadata: {
      platform: "github",
      repository: repo,
      eventType: event.type,
      action,
      watchTerms,
    },
  };
}

export async function collectGithubActivity(source: SourceRecord, env: Env): Promise<SourceAdapterResult> {
  const config = parseJson<GithubActivityConfig>(source.config_json, {});
  const repos = normalizeGithubRepositories(config.repos, 20);
  if (!repos.length) throw new Error("github_activity source needs config.repos");
  const perRepo = Math.max(1, Math.min(100, numberFrom(config.perRepo, 30)));
  const includeTypes = new Set(normalizeStringArray(config.includeTypes));
  const watchTerms = normalizeStringArray(config.watchTerms);
  const headers = new Headers({
    accept: "application/vnd.github+json",
    "user-agent": "Driftglass/0.2",
    "x-github-api-version": "2022-11-28",
  });
  if (env.GITHUB_TOKEN) headers.set("authorization", `Bearer ${env.GITHUB_TOKEN}`);
  const accessClass = env.GITHUB_TOKEN ? "private" as const : "public" as const;

  const settled = await settleRemoteSourceRequests(repos, async (repo) => {
    const response = await fetchWithTimeout(githubRepositoryApiUrl(repo, "events", perRepo), {
      headers,
      redirect: "manual",
    });
    if (!response.ok) {
      const status = response.status;
      await discardRemoteSourceResponse(response, "GitHub activity response rejected");
      throw new Error(`${repo}: HTTP ${status}`);
    }
    const events = await readBoundedResponseJson<GithubEvent[]>(
      response,
      MAX_GITHUB_EVENTS_RESPONSE_BYTES,
      `${repo}: GitHub events response exceeds 4 MB`,
    );
    return events
      .filter((event) => !includeTypes.size || includeTypes.has(event.type))
      .map((event) => eventItem(repo, event, watchTerms, accessClass))
      .filter((item): item is NormalizedItemInput => Boolean(item));
  });

  const items = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  const errors = settled.flatMap((result) => result.status === "rejected" ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : []);
  if (!items.length && errors.length === repos.length) throw new Error(`Every GitHub activity source failed: ${errors.join("; ")}`);
  return { items, provider: "github-events", details: { repos, returned: items.length, partial: errors.length > 0, errors: errors.slice(0, 10) } };
}
