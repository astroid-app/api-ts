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
	"package.json",
	"package-lock.json",
	"tsconfig.json",
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

export type UpdateOptions = {
	// Overwrite files that have local changes instead of skipping them.
	// Excluded config files are still never touched.
	force?: boolean;
};

export type UpdateResult = {
	upToDate: boolean;
	updated: string[];
	deleted: string[];
	skippedExcluded: string[];
	skippedLocalChanges: string[];
	forcedOverLocalChanges: string[];
};

export async function runUpdate(options: UpdateOptions = {}): Promise<UpdateResult> {
	const { force = false } = options;
	const branch = getCurrentBranch();
	log("INFO", `Fetching latest changes from ${REPO_URL} (${REMOTE}/${branch})`);
	git(["fetch", REMOTE, branch]);

	const currentHead = git(["rev-parse", "HEAD"]);
	const remoteHead = git(["rev-parse", `${REMOTE}/${branch}`]);

	if (currentHead === remoteHead) {
		log("INFO", "Already up to date.");
		return {
			upToDate: true,
			updated: [],
			deleted: [],
			skippedExcluded: [],
			skippedLocalChanges: [],
			forcedOverLocalChanges: [],
		};
	}

	const diff = parseDiff(
		git(["diff", "--no-renames", "--name-status", currentHead, remoteHead])
	);

	const updated: string[] = [];
	const deleted: string[] = [];
	const skippedExcluded: string[] = [];
	const skippedLocalChanges: string[] = [];
	const forcedOverLocalChanges: string[] = [];

	for (const { status, file } of diff) {
		if (isExcluded(file)) {
			skippedExcluded.push(file);
			continue;
		}

		const dirty = hasLocalChanges(file);
		if (dirty) {
			if (!force) {
				skippedLocalChanges.push(file);
				continue;
			}
			forcedOverLocalChanges.push(file);
		}

		if (status === "D") {
			git(["rm", "-f", "--", file]);
			deleted.push(file);
		} else {
			// `git checkout <ref> -- <path>` always overwrites the working-tree
			// copy of that path, dirty or not - the hasLocalChanges() check
			// above is what actually gates this, not any flag here.
			git(["checkout", remoteHead, "--", file]);
			updated.push(file);
		}
	}

	if (updated.length > 0 || deleted.length > 0) {
		git([
			"commit",
			"-m",
			`Auto-update from ${REMOTE}/${branch} (${remoteHead.slice(0, 7)})${force ? " [forced]" : ""}`,
		]);
	}

	log(
		"SUCCESS",
		`Update complete. Updated ${updated.length}, deleted ${deleted.length}, skipped ${skippedExcluded.length} excluded, skipped ${skippedLocalChanges.length} with local changes.`
	);
	if (skippedLocalChanges.length > 0) {
		log(
			"WARN",
			`These changed upstream but were left alone due to local modifications: ${skippedLocalChanges.join(", ")}`
		);
	}
	if (forcedOverLocalChanges.length > 0) {
		log(
			"WARN",
			`--force was set: discarded local modifications to these files to apply the upstream version: ${forcedOverLocalChanges.join(", ")}`
		);
	}

	return { upToDate: false, updated, deleted, skippedExcluded, skippedLocalChanges, forcedOverLocalChanges };
}

if (require.main === module) {
	const force = process.argv.includes("--force");
	runUpdate({ force })
		.then((result) => {
			console.log(JSON.stringify(result, null, 2));
		})
		.catch(async (err) => {
			await reportError(null, wrapError("Auto-update failed", err));
			process.exitCode = 1;
		});
}
