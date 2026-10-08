import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendEvent } from "../events.ts";
import { detectWorkspaceCleanliness, resolveWorktreeIsolationDecision } from "../worktree.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "dsh-g443-external-"));
  git(root, ["init", "-q", "-b", "main"]);
  writeFileSync(join(root, "README.md"), "fixture\n");
  git(root, ["add", "README.md"]);
  git(root, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "initial"]);
  return root;
}

test("g-443 real external Git repo: default/custom graph roots and registered worktrees are excluded, user paths remain dirty", () => {
  const workspace = gitFixture();

  const defaultRoot = join(workspace, ".dsh-graph");
  mkdirSync(defaultRoot);
  writeFileSync(join(defaultRoot, "tracked-state.yaml"), "initial: true\n");
  git(workspace, ["add", ".dsh-graph/tracked-state.yaml"]);
  git(workspace, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "tracked plugin data"]);
  writeFileSync(join(defaultRoot, "events.jsonl"), "plugin state\n");
  const defaultProbe = detectWorkspaceCleanliness(workspace, undefined, defaultRoot);
  assert.deepEqual(defaultProbe, { clean: true }, "default graph state must not force isolation");
  assert.equal(resolveWorktreeIsolationDecision("task", undefined, defaultProbe).reason, "type_default");
  assert.equal(resolveWorktreeIsolationDecision("task", undefined, defaultProbe).isolate, false);

  const customWorkspace = gitFixture();
  const customRoot = join(customWorkspace, "plugin data", "graph root");
  mkdirSync(customRoot, { recursive: true });
  const registeredPath = join(customWorkspace, ".worktrees", "g-701-att-001");
  mkdirSync(join(customWorkspace, ".worktrees"), { recursive: true });
  git(customWorkspace, ["worktree", "add", "-q", "-b", "g-701-att-001", registeredPath]);
  appendEvent(customRoot, {
    actor: "test",
    event: "attempt.started",
    goal: "g-701",
    details: { worktree: { path: registeredPath } },
  });
  const customProbe = detectWorkspaceCleanliness(customWorkspace, undefined, customRoot);
  assert.deepEqual(customProbe, { clean: true }, "custom root and graph-recorded Git worktree are plugin-owned");

  // A bare same-name directory in the project root is not plugin-owned handoffs.
  mkdirSync(join(customWorkspace, "handoffs"));
  writeFileSync(join(customWorkspace, "handoffs", "user-note.md"), "user content\n");
  const sameName = detectWorkspaceCleanliness(customWorkspace, undefined, customRoot);
  assert.equal(sameName.clean, false);
  assert.match(sameName.dirtyReason, /handoffs/);

  // A worktree-shaped but unregistered directory is user data, not an exemption.
  const unregisteredPath = join(customWorkspace, ".worktrees", "g-702-att-001");
  mkdirSync(unregisteredPath, { recursive: true });
  writeFileSync(join(unregisteredPath, "user-file.txt"), "user content\n");
  const unregistered = detectWorkspaceCleanliness(customWorkspace, undefined, customRoot);
  assert.equal(unregistered.clean, false);
  assert.match(unregistered.dirtyReason, /g-702-att-001/);

  writeFileSync(join(customWorkspace, "user file.txt"), "real user file\n");
  const userFile = detectWorkspaceCleanliness(customWorkspace, undefined, customRoot);
  assert.equal(userFile.clean, false);
  assert.match(userFile.dirtyReason, /user file\.txt/);
  assert.equal(resolveWorktreeIsolationDecision("patch", undefined, userFile).reason, "dirty_workspace");

  // Tracked changes are never exempted, even under the configured graph root.
  writeFileSync(join(defaultRoot, "tracked-state.yaml"), "initial: false\n");
  const trackedState = detectWorkspaceCleanliness(workspace, undefined, defaultRoot);
  assert.equal(trackedState.clean, false);
  assert.match(trackedState.dirtyReason, /tracked-state\.yaml/);
});

test("g-443 nested workspace resolves status paths from Git top-level for default graph root", () => {
  const workspace = gitFixture();
  const nestedWorkspace = join(workspace, "core");
  mkdirSync(nestedWorkspace);
  writeFileSync(join(nestedWorkspace, "tracked.ts"), "tracked\n");
  git(workspace, ["add", "core/tracked.ts"]);
  git(workspace, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "nested workspace"]);

  const graphRoot = join(workspace, ".dsh-graph");
  mkdirSync(graphRoot);
  writeFileSync(join(graphRoot, "events.jsonl"), "plugin state\n");
  assert.deepEqual(detectWorkspaceCleanliness(nestedWorkspace, undefined, graphRoot), { clean: true });
});

test("g-443 nested workspace does not hide unrelated root .dsh-graph user data under a custom graph root", () => {
  const workspace = gitFixture();
  const nestedWorkspace = join(workspace, "core");
  mkdirSync(nestedWorkspace);
  writeFileSync(join(nestedWorkspace, "tracked.ts"), "tracked\n");
  git(workspace, ["add", "core/tracked.ts"]);
  git(workspace, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "nested workspace"]);

  const customRoot = join(nestedWorkspace, ".dsh-graph");
  mkdirSync(customRoot);
  mkdirSync(join(workspace, ".dsh-graph"));
  writeFileSync(join(workspace, ".dsh-graph", "user-note.md"), "user content\n");
  const result = detectWorkspaceCleanliness(nestedWorkspace, undefined, customRoot);
  assert.equal(result.clean, false);
  assert.match(result.dirtyReason, /\.dsh-graph\/user-note\.md/);
});
