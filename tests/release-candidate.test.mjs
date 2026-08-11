import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  assertDeployButtonMatchesValidation,
  assertDeployButtonRepositoryLink,
  assertDeployButtonsMatchValidation,
  assertInternalWorkspaceUntracked,
  assertReleaseBoundaryProfile,
  cleanAccountDeployState,
  checkReleaseCandidate,
  FORBIDDEN_PUBLIC_RELEASE_PATHS,
  PUBLIC_RELEASE_REPOSITORY_URL,
  RELEASE_BOUNDARY_FILES,
  REQUIRED_RELEASE_FILES,
  REPOSITORY_PLACEHOLDER,
} from "../scripts/check-release-candidate.mjs";

const execFile = promisify(execFileCallback);
const VALID_DEPLOY_BUTTON = `[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=${encodeURIComponent(PUBLIC_RELEASE_REPOSITORY_URL)})\n`;
const PASSED_CLEAN_ACCOUNT_VALIDATION = "| Check | Date | Result | Detail |\n|---|---|---|---|\n| Clean-account Cloudflare deploy | 2026-08-11 | Passed | Clean account passed. |\n";
const PENDING_CLEAN_ACCOUNT_VALIDATION = "| Check | Date | Result | Detail |\n|---|---|---|---|\n| Clean-account Cloudflare deploy | 2026-08-11 | Pending, not run | Not run. |\n";
const CURRENT_GIT_IGNORE = await readFile(new URL("../.gitignore", import.meta.url), "utf8");
const CURRENT_NPM_IGNORE = await readFile(new URL("../.npmignore", import.meta.url), "utf8");
const PUBLIC_GIT_ATTRIBUTES = "migrations/*.sql text eol=lf\n.internal export-ignore\n.internal/** export-ignore\n";
const sourceOnlyReleasePaths = FORBIDDEN_PUBLIC_RELEASE_PATHS.filter((file) => file !== ".internal/");
const sourceOnlyNpmIgnoreLines = new Set(sourceOnlyReleasePaths.map((file) => `/${file}`));
const PUBLIC_GIT_IGNORE = `${CURRENT_GIT_IGNORE.split(/\r?\n/).filter((line) => !/handoff/i.test(line)).join("\n")}\n`;
const PUBLIC_NPM_IGNORE = `${CURRENT_NPM_IGNORE.split(/\r?\n/)
  .filter((line) => line !== "# Private validation and milestone material" && !sourceOnlyNpmIgnoreLines.has(line))
  .join("\n")}\n`;
const VALID_GIT_ATTRIBUTES = `${PUBLIC_GIT_ATTRIBUTES}${sourceOnlyReleasePaths.flatMap((file) => file.endsWith("/")
  ? [`${file.slice(0, -1)} export-ignore`, `${file}** export-ignore`]
  : [`${file} export-ignore`]).join("\n")}\n`;
const VALID_GIT_IGNORE = `${PUBLIC_GIT_IGNORE}!handoff/baseline/v0.9.0-validation.log\n/handoff/evidence/ux-audit/\n`;
const VALID_NPM_IGNORE = `${PUBLIC_NPM_IGNORE}${[...sourceOnlyNpmIgnoreLines].join("\n")}\n`;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function git(root, ...args) {
  await execFile("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
}

async function writeFixtureFile(root, file, content) {
  const destination = path.join(root, file);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content);
}

async function fixtureRepository(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "driftglass-release-gate-test-"));
  await git(root, "init", "--quiet");
  await git(root, "config", "user.name", "Driftglass Release Test");
  await git(root, "config", "user.email", "release-test@invalid.example");
  const withPackage = {
    ".gitattributes": VALID_GIT_ATTRIBUTES,
    ".gitignore": VALID_GIT_IGNORE,
    ".npmignore": VALID_NPM_IGNORE,
    "docs/DEPLOY.md": VALID_DEPLOY_BUTTON,
    "docs/VALIDATION.md": PASSED_CLEAN_ACCOUNT_VALIDATION,
    "public/install.md": VALID_DEPLOY_BUTTON,
    "package.json": `${JSON.stringify({
      name: "driftglass-release-fixture",
      version: "1.0.0",
      private: true,
      scripts: { "release:check": "node scripts/check-release-candidate.mjs" },
    }, null, 2)}\n`,
    "README.md": VALID_DEPLOY_BUTTON,
    ...files,
  };
  for (const [file, content] of Object.entries(withPackage)) {
    if (content !== null) await writeFixtureFile(root, file, content);
  }
  await git(root, "add", "--force", ".");
  await git(root, "commit", "--quiet", "-m", "fixture");
  return root;
}

const fixtureRequiredFiles = ["package.json", "README.md", "required-runtime.txt"];

test("release boundary accepts complete source and normalized public profiles", () => {
  assert.equal(assertReleaseBoundaryProfile({
    gitAttributes: VALID_GIT_ATTRIBUTES,
    gitIgnore: VALID_GIT_IGNORE,
    npmIgnore: VALID_NPM_IGNORE,
  }), "source");
  assert.equal(assertReleaseBoundaryProfile({
    gitAttributes: PUBLIC_GIT_ATTRIBUTES,
    gitIgnore: PUBLIC_GIT_IGNORE,
    npmIgnore: PUBLIC_NPM_IGNORE,
  }), "public");
});

test("release boundary rejects mixed profiles and public-tree private breadcrumbs", () => {
  assert.throws(
    () => assertReleaseBoundaryProfile({
      gitAttributes: PUBLIC_GIT_ATTRIBUTES,
      gitIgnore: PUBLIC_GIT_IGNORE,
      npmIgnore: VALID_NPM_IGNORE,
    }),
    /mixes private-source and normalized-public rules/,
  );
  assert.throws(
    () => assertReleaseBoundaryProfile({
      gitAttributes: PUBLIC_GIT_ATTRIBUTES,
      gitIgnore: VALID_GIT_IGNORE,
      npmIgnore: PUBLIC_NPM_IGNORE,
    }),
    /still names private-source paths:.*handoff/i,
  );
});

test("release gate requires committed archive and npm boundary files", async (t) => {
  for (const boundaryFile of RELEASE_BOUNDARY_FILES) {
    await t.test(boundaryFile, async () => {
      const root = await fixtureRepository({
        [boundaryFile]: null,
        "required-runtime.txt": "tracked runtime\n",
      });
      try {
        await assert.rejects(
          checkReleaseCandidate({ root, requiredFiles: fixtureRequiredFiles, validateArtifact: async () => {} }),
          new RegExp(`Git index is missing: [^\\n]*${boundaryFile.replaceAll(".", "\\.")}[^\\n]*[\\s\\S]*HEAD archive is missing: [^\\n]*${boundaryFile.replaceAll(".", "\\.")}`),
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("release gate rejects forbidden paths left in the committed archive", async () => {
  const root = await fixtureRepository({
    ".gitattributes": "migrations/*.sql text eol=lf\n",
    "required-runtime.txt": "tracked runtime\n",
    "WORK_PROMPT.md": "private validation instructions\n",
  });
  try {
    await assert.rejects(
      checkReleaseCandidate({ root, requiredFiles: fixtureRequiredFiles, validateArtifact: async () => {} }),
      /Tracked release archive contains forbidden private or generated paths: WORK_PROMPT\.md/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release gate rejects a force-tracked internal workspace before export", async () => {
  const root = await fixtureRepository({
    "required-runtime.txt": "tracked runtime\n",
    ".internal/release.md": "private release plan\n",
  });
  try {
    await assert.rejects(
      checkReleaseCandidate({ root, requiredFiles: fixtureRequiredFiles, validateArtifact: async () => {} }),
      /Private \.internal workspace files must remain untracked: \.internal\/release\.md/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("internal workspace guard permits ignored local notes and rejects them in a non-Git artifact", async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "driftglass-internal-boundary-test-"));
  const artifact = await mkdtemp(path.join(os.tmpdir(), "driftglass-internal-artifact-test-"));
  try {
    await git(repository, "init", "--quiet");
    await writeFixtureFile(repository, ".gitignore", "/.internal/\n");
    await writeFixtureFile(repository, ".internal/release.md", "private release plan\n");
    await assert.doesNotReject(assertInternalWorkspaceUntracked(repository));

    await assert.doesNotReject(assertInternalWorkspaceUntracked(artifact));
    await writeFixtureFile(artifact, ".internal/release.md", "private release plan\n");
    await assert.rejects(
      assertInternalWorkspaceUntracked(artifact),
      /Release artifact contains the private \.internal workspace/,
    );
  } finally {
    await rm(repository, { recursive: true, force: true });
    await rm(artifact, { recursive: true, force: true });
  }
});

test("release gate rejects tracked secret, state, and generated paths at any depth", async (t) => {
  for (const file of [
    "nested/.env.local",
    "nested/.envrc",
    "nested/.dev.vars.staging",
    "nested/.dev.varsstaging",
    "nested/.deploy-secrets.prod",
    "nested/.deploy-secrets-prod",
    "nested/.wrangler/state.json",
    "nested/dist/generated.js",
    "nested/output/diagnostic.log",
  ]) {
    await t.test(file, async () => {
      const root = await fixtureRepository({
        "required-runtime.txt": "tracked runtime\n",
        [file]: "must not ship\n",
      });
      try {
        await assert.rejects(
          checkReleaseCandidate({ root, requiredFiles: fixtureRequiredFiles, validateArtifact: async () => {} }),
          new RegExp(`Tracked release archive contains forbidden private or generated paths: ${escapeRegExp(file)}`),
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("release gate verifies npm exclusions against the full committed tree", async (t) => {
  await t.test("rejects a private path omitted from .npmignore", async () => {
    const root = await fixtureRepository({
      ".npmignore": "dist/\n",
      "required-runtime.txt": "tracked runtime\n",
      "WORK_PROMPT.md": "private validation instructions\n",
    });
    try {
      await assert.rejects(
        checkReleaseCandidate({ root, requiredFiles: fixtureRequiredFiles, validateArtifact: async () => {} }),
        /npm package contains forbidden private or generated paths: WORK_PROMPT\.md/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("rejects a generated path omitted from .npmignore", async () => {
    const root = await fixtureRepository({
      ".gitattributes": `${VALID_GIT_ATTRIBUTES}\ndist/** export-ignore\n`,
      ".npmignore": `${FORBIDDEN_PUBLIC_RELEASE_PATHS.map((file) => `/${file}`).join("\n")}\n`,
      "required-runtime.txt": "tracked runtime\n",
      "dist/generated.js": "export {};\n",
    });
    try {
      await assert.rejects(
        checkReleaseCandidate({ root, requiredFiles: fixtureRequiredFiles, validateArtifact: async () => {} }),
        /npm package contains forbidden private or generated paths: dist\/generated\.js/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("rejects nested secrets when npm rules are root-only", async () => {
    const nestedPaths = [
      "nested/.env.local",
      "nested/.envrc",
      "nested/.dev.vars.staging",
      "nested/.dev.varsstaging",
      "nested/.deploy-secrets.prod",
      "nested/.deploy-secrets-prod",
      "nested/.wrangler/state.json",
    ];
    const root = await fixtureRepository({
      ".gitattributes": `${VALID_GIT_ATTRIBUTES}\n${nestedPaths.map((file) => `${file} export-ignore`).join("\n")}\n`,
      ".npmignore": `${FORBIDDEN_PUBLIC_RELEASE_PATHS.map((file) => `/${file}`).join("\n")}\n/.env*\n/.dev.vars*\n/.deploy-secrets*\n/.wrangler/\n`,
      "required-runtime.txt": "tracked runtime\n",
      ...Object.fromEntries(nestedPaths.map((file) => [file, "must not ship\n"])),
    });
    try {
      await assert.rejects(
        checkReleaseCandidate({ root, requiredFiles: fixtureRequiredFiles, validateArtifact: async () => {} }),
        (error) => error.message.startsWith("npm package contains forbidden private or generated paths:")
          && nestedPaths.every((file) => error.message.includes(file)),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("excludes private and nested secret paths", async () => {
    const nestedPaths = [
      "nested/.env.local",
      "nested/.envrc",
      "nested/.dev.vars.staging",
      "nested/.dev.varsstaging",
      "nested/.deploy-secrets.prod",
      "nested/.deploy-secrets-prod",
      "nested/.wrangler/state.json",
    ];
    const root = await fixtureRepository({
      ".gitattributes": `${VALID_GIT_ATTRIBUTES}\n${nestedPaths.map((file) => `${file} export-ignore`).join("\n")}\n`,
      "required-runtime.txt": "tracked runtime\n",
      "WORK_PROMPT.md": "private validation instructions\n",
      "handoff/private.md": "private handoff\n",
      ...Object.fromEntries(nestedPaths.map((file) => [file, "must not ship\n"])),
    });
    let validated = false;
    try {
      const result = await checkReleaseCandidate({
        root,
        requiredFiles: fixtureRequiredFiles,
        validateArtifact: async (artifactRoot) => {
          validated = true;
          await assert.rejects(readFile(path.join(artifactRoot, "WORK_PROMPT.md")), { code: "ENOENT" });
          await assert.rejects(readFile(path.join(artifactRoot, "handoff/private.md")), { code: "ENOENT" });
          for (const file of nestedPaths) {
            await assert.rejects(readFile(path.join(artifactRoot, file)), { code: "ENOENT" });
          }
        },
      });
      assert.equal(validated, true);
      assert.ok(result.npmPackageFileCount > 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("release gate validates committed content instead of dirty worktree content", async () => {
  const root = await fixtureRepository({
    "required-runtime.txt": "tracked runtime\n",
  });
  try {
    await writeFixtureFile(root, "README.md", `${REPOSITORY_PLACEHOLDER}\n`);
    await writeFixtureFile(root, "local-only.txt", "must not enter the release artifact\n");
    let validated = false;
    const result = await checkReleaseCandidate({
      root,
      requiredFiles: fixtureRequiredFiles,
      validateArtifact: async (artifactRoot) => {
        validated = true;
        assert.equal(await readFile(path.join(artifactRoot, "README.md"), "utf8"), VALID_DEPLOY_BUTTON);
        await assert.rejects(readFile(path.join(artifactRoot, "local-only.txt")), { code: "ENOENT" });
      },
    });
    assert.equal(validated, true);
    assert.match(result.revision, /^[a-f0-9]{40}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release gate rejects broken local Markdown references in the archive", async (t) => {
  await t.test("inline link", async () => {
    const root = await fixtureRepository({
      "README.md": `${VALID_DEPLOY_BUTTON}\n[missing guide](docs/missing.md)\n`,
      "required-runtime.txt": "tracked runtime\n",
    });
    try {
      await assert.rejects(
        checkReleaseCandidate({ root, requiredFiles: fixtureRequiredFiles, validateArtifact: async () => {} }),
        /Tracked release archive has broken local Markdown references:\nREADME\.md -> docs\/missing\.md/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("reference definition", async () => {
    const root = await fixtureRepository({
      "README.md": `${VALID_DEPLOY_BUTTON}\n[missing guide][guide]\n\n[guide]: docs/missing.md\n`,
      "required-runtime.txt": "tracked runtime\n",
    });
    try {
      await assert.rejects(
        checkReleaseCandidate({ root, requiredFiles: fixtureRequiredFiles, validateArtifact: async () => {} }),
        /Tracked release archive has broken local Markdown references:\nREADME\.md -> docs\/missing\.md/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("resolved paths with fragments", async () => {
    const root = await fixtureRepository({
      "README.md": `${VALID_DEPLOY_BUTTON}\n[guide](docs/guide.md#start)\n`,
      "docs/guide.md": "# Start\n\n[home](../README.md)\n",
      "required-runtime.txt": "tracked runtime\n",
    });
    try {
      await assert.doesNotReject(
        checkReleaseCandidate({ root, requiredFiles: fixtureRequiredFiles, validateArtifact: async () => {} }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("release gate rejects private package scripts retained in the archive", async () => {
  const root = await fixtureRepository({
    "package.json": `${JSON.stringify({
      name: "driftglass-release-fixture",
      version: "1.0.0",
      private: true,
      scripts: {
        "release:check": "node scripts/check-release-candidate.mjs",
        "milestones:check": "node scripts/check-milestones.mjs",
      },
    }, null, 2)}\n`,
    "required-runtime.txt": "tracked runtime\n",
  });
  try {
    await assert.rejects(
      checkReleaseCandidate({ root, requiredFiles: fixtureRequiredFiles, validateArtifact: async () => {} }),
      /Tracked package\.json exposes private or unavailable scripts: milestones:check/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release gate rejects the repository placeholder in HEAD or the Git index", async (t) => {
  await t.test("committed placeholder", async () => {
    const root = await fixtureRepository({
      "README.md": `${REPOSITORY_PLACEHOLDER}\n`,
      "required-runtime.txt": "tracked runtime\n",
    });
    try {
      await assert.rejects(
        checkReleaseCandidate({ root, requiredFiles: fixtureRequiredFiles, validateArtifact: async () => {} }),
        (error) => error.message.includes(`HEAD still contains ${REPOSITORY_PLACEHOLDER}`),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("staged placeholder", async () => {
    const root = await fixtureRepository({
      "required-runtime.txt": "tracked runtime\n",
    });
    try {
      await writeFixtureFile(root, "README.md", `${REPOSITORY_PLACEHOLDER}\n`);
      await git(root, "add", "README.md");
      await assert.rejects(
        checkReleaseCandidate({ root, requiredFiles: fixtureRequiredFiles, validateArtifact: async () => {} }),
        (error) => error.message.includes(`Git index still contains ${REPOSITORY_PLACEHOLDER}`),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("release gate rejects required files that exist only outside the committed archive", async (t) => {
  await t.test("untracked file", async () => {
    const root = await fixtureRepository({});
    try {
      await writeFixtureFile(root, "required-runtime.txt", "untracked runtime\n");
      await assert.rejects(
        checkReleaseCandidate({ root, requiredFiles: fixtureRequiredFiles, validateArtifact: async () => {} }),
        /Git index is missing: required-runtime\.txt[\s\S]*HEAD archive is missing: required-runtime\.txt/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("staged but uncommitted file", async () => {
    const root = await fixtureRepository({});
    try {
      await writeFixtureFile(root, "required-runtime.txt", "staged runtime\n");
      await git(root, "add", "required-runtime.txt");
      await assert.rejects(
        checkReleaseCandidate({ root, requiredFiles: fixtureRequiredFiles, validateArtifact: async () => {} }),
        /HEAD archive is missing: required-runtime\.txt/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("release gate keeps the deploy button aligned with the recorded clean-account state", async (t) => {
  await t.test("accepts GitHub and GitLab repository URLs", () => {
    assert.doesNotThrow(() => assertDeployButtonRepositoryLink(VALID_DEPLOY_BUTTON));
    assert.doesNotThrow(() => assertDeployButtonRepositoryLink(
      "[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgitlab.com%2Fgroup%2Fproject)\n",
    ));
  });

  await t.test("accepts no active button while the clean-account run is pending", async () => {
    assert.equal(cleanAccountDeployState(PENDING_CLEAN_ACCOUNT_VALIDATION), "pending");
    assert.equal(assertDeployButtonMatchesValidation({
      readme: "# Install on Cloudflare\n",
      validation: PENDING_CLEAN_ACCOUNT_VALIDATION,
    }), "pending");
    const root = await fixtureRepository({
      "README.md": "# Install on Cloudflare\n",
      "docs/DEPLOY.md": "# Deploy from a source checkout\n",
      "docs/VALIDATION.md": PENDING_CLEAN_ACCOUNT_VALIDATION,
      "public/install.md": "# Install on Cloudflare\n",
      "required-runtime.txt": "tracked runtime\n",
    });
    try {
      const result = await checkReleaseCandidate({
        root,
        requiredFiles: fixtureRequiredFiles,
        validateArtifact: async () => {},
      });
      assert.equal(result.cleanAccountState, "pending");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("requires the exact public repository after the clean-account run passes", () => {
    assert.equal(cleanAccountDeployState(PASSED_CLEAN_ACCOUNT_VALIDATION), "passed");
    const exactDocuments = [
      ["README.md", VALID_DEPLOY_BUTTON],
      ["docs/DEPLOY.md", VALID_DEPLOY_BUTTON],
      ["public/install.md", VALID_DEPLOY_BUTTON],
    ];
    assert.equal(assertDeployButtonsMatchValidation({
      documents: exactDocuments,
      validation: PASSED_CLEAN_ACCOUNT_VALIDATION,
    }), "passed");
    assert.throws(
      () => assertDeployButtonsMatchValidation({
        documents: exactDocuments.map(([label, source]) => [
          label,
          label === "public/install.md"
            ? "[Deploy](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fsomeone-else%2Fdriftglass)\n"
            : source,
        ]),
        validation: PASSED_CLEAN_ACCOUNT_VALIDATION,
      }),
      /public\/install\.md Deploy to Cloudflare link must set url to the exact repository URL/,
    );
    assert.throws(
      () => assertDeployButtonsMatchValidation({
        documents: exactDocuments.map(([label, source]) => [label, label === "docs/DEPLOY.md" ? "# Source checkout\n" : source]),
        validation: PASSED_CLEAN_ACCOUNT_VALIDATION,
      }),
      /docs\/DEPLOY\.md does not contain a Deploy to Cloudflare link/,
    );
  });

  await t.test("pending state rejects an active link in each public entry document", () => {
    for (const activeLabel of ["README.md", "docs/DEPLOY.md", "public/install.md"]) {
      const documents = ["README.md", "docs/DEPLOY.md", "public/install.md"]
        .map((label) => [label, label === activeLabel ? VALID_DEPLOY_BUTTON : "# Source checkout\n"]);
      assert.throws(
        () => assertDeployButtonsMatchValidation({ documents, validation: PENDING_CLEAN_ACCOUNT_VALIDATION }),
        new RegExp(`Tracked ${activeLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} must not activate Deploy to Cloudflare`),
      );
    }
  });

  for (const [name, readme, validation, expected] of [
    [
      "pending state rejects an active button",
      VALID_DEPLOY_BUTTON,
      PENDING_CLEAN_ACCOUNT_VALIDATION,
      /must not activate Deploy to Cloudflare while clean-account deployment is Pending, not run/,
    ],
    ["passed state rejects a missing link", "# No deploy button\n", PASSED_CLEAN_ACCOUNT_VALIDATION, /does not contain a Deploy to Cloudflare link/],
    [
      "malformed repository URL",
      "[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=not-a-url)\n",
      PASSED_CLEAN_ACCOUNT_VALIDATION,
      /must set url to the exact repository URL/,
    ],
    [
      "unsupported repository host",
      "[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fexample.com%2Fowner%2Frepository)\n",
      PASSED_CLEAN_ACCOUNT_VALIDATION,
      /must set url to the exact repository URL/,
    ],
  ]) {
    await t.test(name, async () => {
      const root = await fixtureRepository({
        "README.md": readme,
        "docs/VALIDATION.md": validation,
        "required-runtime.txt": "tracked runtime\n",
      });
      try {
        await assert.rejects(
          checkReleaseCandidate({ root, requiredFiles: fixtureRequiredFiles, validateArtifact: async () => {} }),
          expected,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

function boundaryPackage({ dependencies = {}, checkDeploy = "node scripts/check-deploy.mjs" } = {}) {
  return `${JSON.stringify({
    name: "release-gate-boundary",
    version: "1.0.0",
    private: true,
    type: "module",
    scripts: {
      "check:deploy": checkDeploy,
      "release:check": "node scripts/check-release-candidate.mjs",
    },
    dependencies,
  }, null, 2)}\n`;
}

function emptyBoundaryLock() {
  return `${JSON.stringify({
    name: "release-gate-boundary",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "release-gate-boundary",
        version: "1.0.0",
      },
    },
  }, null, 2)}\n`;
}

const boundaryRequiredFiles = ["package.json", "package-lock.json", "README.md", "scripts/check-deploy.mjs"];

test("archived dependency installation enforces lock and declaration boundaries", async (t) => {
  await t.test("rejects a package.json that is inconsistent with the archived lockfile", async () => {
    const root = await fixtureRepository({
      "package.json": boundaryPackage({ dependencies: { "release-gate-local-package": "file:vendor/release-gate-local-package" } }),
      "package-lock.json": emptyBoundaryLock(),
      "scripts/check-deploy.mjs": "throw new Error('npm ci should fail before deploy validation');\n",
      "vendor/release-gate-local-package/package.json": `${JSON.stringify({
        name: "release-gate-local-package",
        version: "1.0.0",
      }, null, 2)}\n`,
    });
    try {
      await assert.rejects(
        checkReleaseCandidate({ root, requiredFiles: boundaryRequiredFiles }),
        /npm(?:\.cmd)? ci --no-audit --no-fund exited with 1/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("does not borrow an undeclared CLI from the checkout PATH", async () => {
    const cliName = `driftglass-checkout-only-${process.pid}-${Date.now()}`;
    const root = await fixtureRepository({
      "package.json": boundaryPackage({ checkDeploy: cliName }),
      "package-lock.json": emptyBoundaryLock(),
      "scripts/check-deploy.mjs": "throw new Error('checkout-only CLI must not be reachable');\n",
    });
    const checkoutBin = path.join(root, "node_modules", ".bin");
    await mkdir(checkoutBin, { recursive: true });
    await writeFile(
      path.join(checkoutBin, process.platform === "win32" ? `${cliName}.cmd` : cliName),
      process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    );
    const originalPath = process.env.PATH;
    process.env.PATH = `${checkoutBin}${path.delimiter}${originalPath ?? ""}`;
    try {
      if (process.platform === "win32") {
        await execFile(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", cliName], {
          cwd: root,
          env: process.env,
          windowsHide: true,
        });
      } else {
        await execFile(cliName, [], { cwd: root, env: process.env, windowsHide: true });
      }
      await assert.rejects(
        checkReleaseCandidate({ root, requiredFiles: boundaryRequiredFiles }),
        /npm(?:\.cmd)? run check:deploy exited with (?:1|127)/,
      );
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("does not borrow an undeclared CommonJS dependency through NODE_PATH", async () => {
    await import("typescript");
    const root = await fixtureRepository({
      "package.json": boundaryPackage(),
      "package-lock.json": emptyBoundaryLock(),
      "scripts/check-deploy.mjs": "import { createRequire } from 'node:module';\ncreateRequire(import.meta.url)('typescript');\n",
    });
    const originalNodePath = process.env.NODE_PATH;
    process.env.NODE_PATH = fileURLToPath(new URL("../node_modules/", import.meta.url));
    try {
      await assert.rejects(
        checkReleaseCandidate({ root, requiredFiles: boundaryRequiredFiles }),
        /npm(?:\.cmd)? run check:deploy exited with 1/,
      );
    } finally {
      if (originalNodePath === undefined) delete process.env.NODE_PATH;
      else process.env.NODE_PATH = originalNodePath;
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("release manifest covers every published install and CI boundary", async () => {
  const requiredGroups = {
    cloudflare: [
      ".deploy-secrets.example",
      ".dev.vars.example",
      "package-lock.json",
      "docs/VALIDATION.md",
      "wrangler.jsonc",
      "src/index.ts",
      "src/worker-configuration.d.ts",
      "scripts/compile-tests.mjs",
      "scripts/configure-r2-lifecycle.mjs",
      "scripts/verify-repo.mjs",
    ],
    currentMigrations: [
      "migrations/0018_email_receipt_idempotency.sql",
      "migrations/0019_queue_ingest_durability.sql",
      "migrations/0020_ingest_completion_state.sql",
      "migrations/0021_ingest_deadletter_retry_claims.sql",
      "migrations/0022_source_ingest_producer_outbox.sql",
      "migrations/0023_mission_match_evidence_index.sql",
    ],
    optionalPackageLocks: [
      "labs/agent-memory-bridge/package-lock.json",
      "labs/deep-dive-lab/package-lock.json",
    ],
    selfhost: [
      "docs/PORTABLE-RUNTIME.md",
      "scripts/build-selfhost.mjs",
      "src/runtime/node/cli.ts",
      "src/runtime/node/cloudflare-import-boundary.ts",
      "tsconfig.node-http.json",
    ],
    reusablePlugin: [
      "plugins/driftglass/.codex-plugin/plugin.json",
      "plugins/driftglass/skills/answer-mission/SKILL.md",
      "plugins/driftglass/skills/answer-mission/agents/openai.yaml",
    ],
    releasePrivacy: [
      "scripts/check-release-privacy.mjs",
      "tests/release-privacy.test.mjs",
    ],
    socialCard: [
      ".github/dependabot.yml",
      "public/icons/driftglass-og.png",
      "public/icons/driftglass-og.source.sha256",
      "public/icons/driftglass-share-fallback.png",
      "public/icons/driftglass-share-fallback.source.sha256",
      "scripts/build-social-card.mjs",
    ],
  };
  for (const [group, files] of Object.entries(requiredGroups)) {
    for (const file of files) assert.ok(REQUIRED_RELEASE_FILES.includes(file), `${group}: ${file}`);
  }

  for (const file of RELEASE_BOUNDARY_FILES) assert.ok(REQUIRED_RELEASE_FILES.includes(file), file);

  assert.equal(new Set(REQUIRED_RELEASE_FILES).size, REQUIRED_RELEASE_FILES.length, "required files are unique");
  assert.ok(
    REQUIRED_RELEASE_FILES.every((file) => !file.endsWith("/.app.json") && !file.startsWith("dist/") && !file.startsWith(".test-dist/")),
    "the release manifest excludes personalized and generated output",
  );

  const [packageRaw, workflow, selfhostBuilder, gitAttributes, gitIgnore, npmIgnore, verifier] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
    readFile(new URL("../scripts/build-selfhost.mjs", import.meta.url), "utf8"),
    readFile(new URL("../.gitattributes", import.meta.url), "utf8"),
    readFile(new URL("../.gitignore", import.meta.url), "utf8"),
    readFile(new URL("../.npmignore", import.meta.url), "utf8"),
    readFile(new URL("../scripts/verify-repo.mjs", import.meta.url), "utf8"),
  ]);
  const pkg = JSON.parse(packageRaw);
  assert.equal(pkg.scripts["selfhost:build"], "node scripts/build-selfhost.mjs");
  assert.match(selfhostBuilder, /entryPoints: \[join\(repository, "src", "runtime", "node", "cli\.ts"\)\]/);
  assert.match(selfhostBuilder, /"cloudflare-import-boundary\.ts"/);
  assert.match(workflow, /npm ci --prefix labs\/deep-dive-lab/);
  assert.match(workflow, /npm ci --prefix labs\/agent-memory-bridge/);
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /npm run release:privacy/);
  assert.match(verifier, /await assertInternalWorkspaceUntracked\(root\)/);
  assert.ok(["source", "public"].includes(assertReleaseBoundaryProfile({ gitAttributes, gitIgnore, npmIgnore })));
  const npmIgnoreLines = new Set(npmIgnore.split(/\r?\n/));
  for (const pattern of [
    ".dev.vars*",
    "!/.dev.vars.example",
    "!/.dev.vars.local.example",
    ".env*",
    "!/.env.example",
    ".deploy-secrets*",
    "!/.deploy-secrets.example",
    ".wrangler/",
    "dist/",
    ".test-dist/",
    "output/",
  ]) assert.ok(npmIgnoreLines.has(pattern), pattern);
});

test("release gate stays separate while public docs keep the direct deployment path", async () => {
  const [packageRaw, workflow, deploy, readme, install, release] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
    readFile(new URL("../docs/DEPLOY.md", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../public/install.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/RELEASE-0.9.0.md", import.meta.url), "utf8"),
  ]);
  const pkg = JSON.parse(packageRaw);
  assert.equal(pkg.scripts["release:check"], "node scripts/check-release-candidate.mjs");
  assert.equal(pkg.scripts["release:privacy"], "node scripts/check-release-privacy.mjs --history");
  assert.equal(pkg.scripts["test:compile"], "node scripts/compile-tests.mjs");
  assert.doesNotMatch(pkg.scripts.check, /release:check/);
  assert.doesNotMatch(pkg.scripts.check, /release:privacy/);
  assert.doesNotMatch(pkg.scripts.check, /milestones:check/);
  assert.equal(pkg.scripts["milestones:check"], undefined);
  assert.doesNotMatch(pkg.scripts["check:deploy"], /release:check/);
  assert.doesNotMatch(pkg.scripts["check:deploy"], /release:privacy/);
  assert.match(workflow, /npm run release:privacy/);
  assert.match(workflow, /npm run check:deploy/);
  assert.doesNotMatch(workflow, /npm run release:check/);
  assert.match(deploy, /npm run check:deploy/);
  assert.match(deploy, /npm run deploy:first/);
  assert.match(deploy, /^## Deploy from a source checkout$/m);
  assert.match(readme, /^### 1\. Install on Cloudflare$/m);
  assert.match(install, /^## Install on Cloudflare$/m);
  assert.match(release, /The Cloudflare deployment is configured to provision/);
  for (const publicDocument of [deploy, readme, install, release]) {
    assert.doesNotMatch(publicDocument, /npm run release:(?:check|privacy)|tracked `HEAD` archive|every reachable Git blob|clean-account validation/i);
  }
});
