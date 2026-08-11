const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;

/** Canonicalize one GitHub repository while rejecting path/query confusion. */
export function normalizeGithubRepository(value: unknown): string {
  if (typeof value !== "string") throw new Error("GitHub repositories must use owner/repository");
  const input = value.trim();
  const parts = input.split("/");
  const owner = parts[0] ?? "";
  const repository = parts[1] ?? "";
  if (
    parts.length !== 2
    || !GITHUB_OWNER.test(owner)
    || !GITHUB_REPOSITORY.test(repository)
    || repository === "."
    || repository === ".."
  ) {
    throw new Error(`Invalid GitHub repository “${input.slice(0, 140)}”; use owner/repository`);
  }
  return `${owner}/${repository}`;
}

export function normalizeGithubRepositories(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const unique = new Map<string, string>();
  for (const entry of value) {
    const repository = normalizeGithubRepository(entry);
    const key = repository.toLowerCase();
    if (!unique.has(key)) unique.set(key, repository);
  }
  return [...unique.values()].slice(0, Math.max(1, Math.floor(limit)));
}

export function githubRepositoryApiUrl(repository: string, resource: "releases" | "events", perPage: number): string {
  const normalized = normalizeGithubRepository(repository);
  const [owner, name] = normalized.split("/");
  const url = new URL(`https://api.github.com/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/${resource}`);
  url.searchParams.set("per_page", String(Math.max(1, Math.floor(perPage))));
  return url.toString();
}
