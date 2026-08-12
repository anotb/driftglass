export interface RelayCapabilityDescriptor {
  id: string;
  group: string;
  title: string;
  description: string;
  requiredArgs?: string[];
  optionalArgs?: string[];
  dynamic?: boolean;
}

export const RELAY_CAPABILITIES: readonly RelayCapabilityDescriptor[] = [
  { id: "x.trending", group: "X", title: "Trending", description: "Read the current X trends available to the signed-in browser profile." },
  { id: "x.search", group: "X", title: "Search", description: "Search X posts with latest/top filtering.", requiredArgs: ["query"], optionalArgs: ["filter", "limit"] },
  { id: "x.timeline", group: "X", title: "For You / Following", description: "Read a bounded snapshot of the signed-in For You or Following timeline.", optionalArgs: ["type", "limit"] },
  { id: "x.bookmarks", group: "X", title: "Bookmarks", description: "Read the signed-in account's bookmarked posts.", optionalArgs: ["limit"] },
  { id: "x.list", group: "X", title: "List timeline", description: "Read posts from an X List.", requiredArgs: ["id"], optionalArgs: ["limit"] },
  { id: "x.thread", group: "X", title: "Thread", description: "Read a post and its thread context.", requiredArgs: ["id"] },
  { id: "x.notifications", group: "X", title: "Notifications", description: "Read the signed-in account's notifications.", optionalArgs: ["limit"] },
  { id: "x.likes", group: "X", title: "Likes", description: "Read visible liked posts.", optionalArgs: ["name", "limit"] },
  { id: "x.user", group: "X", title: "Profile", description: "Read an X profile.", requiredArgs: ["name"] },
  { id: "x.user-posts", group: "X", title: "User posts", description: "Read recent posts from an X profile.", requiredArgs: ["name"], optionalArgs: ["limit"] },
  { id: "x.article", group: "X", title: "Article", description: "Read an X long-form article.", requiredArgs: ["id"] },

  { id: "reddit.frontpage", group: "Reddit", title: "Front page", description: "Read the public front page / r/all.", optionalArgs: ["limit"] },
  { id: "reddit.home", group: "Reddit", title: "Home", description: "Read the signed-in personalized Reddit home feed.", optionalArgs: ["limit"] },
  { id: "reddit.popular", group: "Reddit", title: "Popular", description: "Read Reddit Popular.", optionalArgs: ["limit"] },
  { id: "reddit.subreddit", group: "Reddit", title: "Subreddit", description: "Read a subreddit with sort/time controls.", requiredArgs: ["subreddit"], optionalArgs: ["sort", "time", "limit"] },
  { id: "reddit.search", group: "Reddit", title: "Search", description: "Search Reddit posts.", requiredArgs: ["query"], optionalArgs: ["limit"] },
  { id: "reddit.saved", group: "Reddit", title: "Saved", description: "Read the signed-in account's saved items.", optionalArgs: ["limit"] },
  { id: "reddit.upvoted", group: "Reddit", title: "Upvoted", description: "Read the signed-in account's upvoted posts.", optionalArgs: ["limit"] },
  { id: "reddit.subscribed", group: "Reddit", title: "Subscriptions", description: "List subscribed communities.", optionalArgs: ["limit"] },
  { id: "reddit.thread", group: "Reddit", title: "Post and comments", description: "Read a post and comment tree.", requiredArgs: ["id"], optionalArgs: ["depth", "expandMore", "expandRounds"] },
  { id: "reddit.user", group: "Reddit", title: "User", description: "Read a Reddit user profile.", requiredArgs: ["name"] },
  { id: "reddit.user-posts", group: "Reddit", title: "User posts", description: "Read a Reddit user's submitted posts.", requiredArgs: ["name"], optionalArgs: ["limit"] },
  { id: "reddit.user-comments", group: "Reddit", title: "User comments", description: "Read a Reddit user's comments.", requiredArgs: ["name"], optionalArgs: ["limit"] },
  { id: "reddit.subreddit-info", group: "Reddit", title: "Community info", description: "Read subreddit metadata.", requiredArgs: ["subreddit"] },

  { id: "youtube.search", group: "YouTube", title: "Search", description: "Search YouTube.", requiredArgs: ["query"], optionalArgs: ["limit"] },
  { id: "youtube.video", group: "YouTube", title: "Video", description: "Read video metadata.", requiredArgs: ["id"] },
  { id: "youtube.transcript", group: "YouTube", title: "Transcript", description: "Read timestamped captions/transcript.", requiredArgs: ["id"] },
  { id: "youtube.comments", group: "YouTube", title: "Comments", description: "Read video comments.", requiredArgs: ["id"], optionalArgs: ["limit"] },
  { id: "youtube.channel", group: "YouTube", title: "Channel", description: "Read channel information and recent videos.", requiredArgs: ["id"], optionalArgs: ["limit"] },
  { id: "youtube.playlist", group: "YouTube", title: "Playlist", description: "Read playlist items.", requiredArgs: ["id"], optionalArgs: ["limit"] },
  { id: "youtube.feed", group: "YouTube", title: "Home feed", description: "Read the signed-in YouTube home recommendations.", optionalArgs: ["limit"] },
  { id: "youtube.history", group: "YouTube", title: "History", description: "Read the signed-in watch history.", optionalArgs: ["limit"] },
  { id: "youtube.watch-later", group: "YouTube", title: "Watch Later", description: "Read the signed-in Watch Later queue.", optionalArgs: ["limit"] },
  { id: "youtube.subscriptions", group: "YouTube", title: "Subscriptions", description: "Read subscribed channels.", optionalArgs: ["limit"] },

  { id: "linkedin.timeline", group: "LinkedIn", title: "Timeline", description: "Read the signed-in LinkedIn home timeline.", optionalArgs: ["limit"] },
  { id: "linkedin.jobs", group: "LinkedIn", title: "Jobs", description: "Search LinkedIn jobs.", requiredArgs: ["query"], optionalArgs: ["location", "remote", "details", "limit"] },
  { id: "linkedin.people", group: "LinkedIn", title: "People search", description: "Search LinkedIn people.", requiredArgs: ["query"], optionalArgs: ["limit"] },
  { id: "linkedin.profile", group: "LinkedIn", title: "Profile", description: "Read a visible LinkedIn profile.", optionalArgs: ["url"] },
  { id: "linkedin.posts", group: "LinkedIn", title: "Posts", description: "Read visible posts from a LinkedIn profile.", optionalArgs: ["url", "limit"] },
  { id: "linkedin.job", group: "LinkedIn", title: "Job detail", description: "Read one LinkedIn job page.", requiredArgs: ["url"] },

  { id: "instagram.explore", group: "Instagram", title: "Explore", description: "Read the signed-in Instagram Explore feed.", optionalArgs: ["limit"] },
  { id: "instagram.search", group: "Instagram", title: "User search", description: "Search Instagram users.", requiredArgs: ["query"], optionalArgs: ["limit"] },
  { id: "instagram.user", group: "Instagram", title: "Recent posts", description: "Read recent posts from an Instagram account.", requiredArgs: ["name"], optionalArgs: ["limit"] },
  { id: "instagram.profile", group: "Instagram", title: "Profile", description: "Read an Instagram profile.", requiredArgs: ["name"] },

  { id: "facebook.feed", group: "Facebook", title: "Feed", description: "Read the signed-in Facebook feed.", optionalArgs: ["limit"] },
  { id: "facebook.search", group: "Facebook", title: "Search", description: "Search Facebook.", requiredArgs: ["query"], optionalArgs: ["limit"] },
  { id: "facebook.groups", group: "Facebook", title: "Groups", description: "Read visible groups and recent activity.", optionalArgs: ["limit"] },
  { id: "facebook.profile", group: "Facebook", title: "Profile", description: "Read a Facebook profile or page.", requiredArgs: ["name"] },

  { id: "tiktok.explore", group: "TikTok", title: "Explore", description: "Read TikTok Explore.", optionalArgs: ["limit"] },
  { id: "tiktok.search", group: "TikTok", title: "Search", description: "Search TikTok.", requiredArgs: ["query"], optionalArgs: ["limit"] },
  { id: "tiktok.user", group: "TikTok", title: "User posts", description: "Read recent posts from a TikTok user.", requiredArgs: ["name"], optionalArgs: ["limit"] },
  { id: "tiktok.profile", group: "TikTok", title: "Profile", description: "Read a TikTok profile.", requiredArgs: ["name"] },

  { id: "opencli.read", group: "OpenCLI catalog", title: "Any discovered read adapter", description: "Invoke any OpenCLI command whose shipped manifest marks it access=read.", requiredArgs: ["site", "command"], optionalArgs: ["params"], dynamic: true },
] as const;

export const READ_ONLY_CAPABILITIES = RELAY_CAPABILITIES.map((capability) => capability.id) as readonly string[];
export const WORKSPACE_MIRROR_CAPABILITY = "workspace.mirror" as const;
export const PAIRABLE_COLLECTOR_CAPABILITIES = Object.freeze([
  ...READ_ONLY_CAPABILITIES,
  WORKSPACE_MIRROR_CAPABILITY,
]);

export type RelayCapability = typeof RELAY_CAPABILITIES[number]["id"];

export function isRelayCapability(value: string): value is RelayCapability {
  return READ_ONLY_CAPABILITIES.includes(value);
}

export function relayCapability(value: string): RelayCapabilityDescriptor | undefined {
  return RELAY_CAPABILITIES.find((capability) => capability.id === value);
}

export function missingRelayCapabilityArgs(operation: string, args: unknown): string[] {
  const requiredArgs = relayCapability(operation)?.requiredArgs ?? [];
  const values = args && typeof args === "object" && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {};
  return requiredArgs.filter((name) => String(values[name] ?? "").trim().length === 0);
}

export function relayCapabilityArgsError(operation: string, args: unknown, prefix = "args"): string | null {
  const missing = missingRelayCapabilityArgs(operation, args);
  if (missing.length === 0) return null;
  return `${operation} requires ${missing.map((name) => `${prefix}.${name}`).join(" and ")}`;
}
