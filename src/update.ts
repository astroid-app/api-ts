import { execFileSync } from "child_process";
import * as path from "path";
import log from "./utils/logger";
import { reportError, wrapError } from "./ErrorHandler";

const REMOTE = "origin";
const REPO_URL = "https://github.com/astroid-app/api-ts.git";
const REPO_ROOT = path.resolve(__dirname, "..");

// Files that stay untouched even when they changed upstream
const EXCLUDED_PATHS = new Set([
	".env",
	".gitignore",
	"package-lock.json",
]);

function isExcluded(filePath: string): boolean {
	return EXCLUDED_PATHS.has(filePath);
}

function git(args: string[]): string {
	return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function getCurrentBranch(): string {
	return git(["branch", "--show-current"]);
}

function hasLocalChanges(filePath: string): boolean {
	return git(["status", "--porcelain", "--", filePath]).length > 0;
}

function tryGit(args: string[]): boolean {
	try {
		execFileSync("git", args, { cwd: REPO_ROOT, stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function listLines(raw: string): string[] {
	return raw.split("\n").map((l) => l.trim()).filter(Boolean);
}

function hasStagedChanges(): boolean {
	// `git diff --cached --quiet` exits non-zero when something is staged
	return !tryGit(["diff", "--cached", "--quiet"]);
}

function isMergeInProgress(): boolean {
	return tryGit(["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
}

// Leftover conflicts (e.g. from an earlier failed `git pull`) block every
// commit, so resolve them first: config files keep the local version,
// everything else takes the upstream version.
function resolveConflicts(remoteHead: string): string[] {
	const unmerged = listLines(git(["diff", "--name-only", "--diff-filter=U"]));
	for (const file of unmerged) {
		if (isExcluded(file)) {
			if (tryGit(["checkout", "--ours", "--", file]) || tryGit(["checkout", "--theirs", "--", file])) {
				git(["add", "--", file]);
			} else {
				git(["rm", "-f", "--", file]);
			}
		} else if (tryGit(["cat-file", "-e", `${remoteHead}:${file}`])) {
			git(["checkout", remoteHead, "--", file]);
		} else {
			git(["rm", "-f", "--", file]);
		}
	}
	return unmerged;
}

type DiffEntry = { status: string; file: string };

function parseDiff(raw: string): DiffEntry[] {
	return raw
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [status, file] = line.split("\t");
			return { status, file };
		});
}

export type UpdateResult = {
	upToDate: boolean;
	updated: string[];
	deleted: string[];
	skippedExcluded: string[];
	// Files that had unresolved merge conflicts before the update
	resolvedConflicts: string[];
	// Files whose local modifications were overwritten by the upstream version
	overwrittenLocalChanges: string[];
};

export async function runUpdate(): Promise<UpdateResult> {
	const branch = getCurrentBranch();
	log("INFO", `Fetching latest changes from ${REPO_URL} (${REMOTE}/${branch})`);
	git(["fetch", REMOTE, branch]);

	const currentHead = git(["rev-parse", "HEAD"]);
	const remoteHead = git(["rev-parse", `${REMOTE}/${branch}`]);

	const resolvedConflicts = resolveConflicts(remoteHead);
	if (resolvedConflicts.length > 0) {
		log("WARN", `Resolved leftover merge conflicts in: ${resolvedConflicts.join(", ")}`);
	}

	if (currentHead === remoteHead && resolvedConflicts.length === 0 && !isMergeInProgress()) {
		log("INFO", "Already up to date.");
		return {
			upToDate: true,
			updated: [],
			deleted: [],
			skippedExcluded: [],
			resolvedConflicts: [],
			overwrittenLocalChanges: [],
		};
	}

	const diff = parseDiff(
		git(["diff", "--no-renames", "--name-status", currentHead, remoteHead])
	);

	const updated: string[] = [];
	const deleted: string[] = [];
	const skippedExcluded: string[] = [];
	const overwrittenLocalChanges: string[] = [];

	for (const { status, file } of diff) {
		if (isExcluded(file)) {
			skippedExcluded.push(file);
			continue;
		}

		// Only config files (EXCLUDED_PATHS) are protected; everything else
		// gets the upstream version even if it was modified locally.
		if (hasLocalChanges(file)) {
			overwrittenLocalChanges.push(file);
		}

		if (status === "D") {
			git(["rm", "-f", "--", file]);
			deleted.push(file);
		} else {
			// `git checkout <ref> -- <path>` overwrites the working-tree copy
			// of that path, dirty or not.
			git(["checkout", remoteHead, "--", file]);
			updated.push(file);
		}
	}

	// A merge left in progress must be concluded with a commit even if
	// nothing new is staged.
	if (hasStagedChanges() || isMergeInProgress()) {
		git([
			"commit",
			"-m",
			`Auto-update from ${REMOTE}/${branch} (${remoteHead.slice(0, 7)})`,
		]);
	}

	log(
		"SUCCESS",
		`Update complete. Updated ${updated.length}, deleted ${deleted.length}, skipped ${skippedExcluded.length} excluded config files.`
	);
	if (overwrittenLocalChanges.length > 0) {
		log(
			"WARN",
			`Discarded local modifications to apply the upstream version: ${overwrittenLocalChanges.join(", ")}`
		);
	}

	return { upToDate: false, updated, deleted, skippedExcluded, resolvedConflicts, overwrittenLocalChanges };
}

if (require.main === module) {
	runUpdate()
		.then((result) => {
			console.log(JSON.stringify(result, null, 2));
		})
		.catch(async (err) => {
			await reportError(null, wrapError("Auto-update failed", err));
			process.exitCode = 1;
		});
}
