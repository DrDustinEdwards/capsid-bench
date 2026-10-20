"""The frame's repository list (protocol section 4, "Frame"): every repository in a
SWE-rebench-format dataset at one recorded commit, with the install recipe a task from it
would use. Reads local parquet files fetched at that commit: registers nothing, starts no
run, calls no model. Eligibility (language, licence, owner) is checked against GitHub by
scripts/candidates.mjs, which reads this file.

  python3 scripts/repos.py <dir-of-parquet> <manifest.json> <out.json>

The manifest records the dataset, its commit and each file's sha256, as the workflow
fetched them. A repository with several instances uses the recipe of its newest instance
(the latest created_at, ties broken by instance id), the one nearest a post-cutoff base
commit. A repository whose instances carry no recipe is listed with none, so its tasks are
excluded later as "no recipe" rather than dropped from the list unseen."""

import json
import sys

import duckdb


def recipe_of(value):
    """The recipe as published: a struct comes back as a dict, a JSON column as text."""
    if value is None:
        return None
    if isinstance(value, str):
        if not value.strip():
            return None
        try:
            return json.loads(value)
        except ValueError:
            return value
    return value


def main():
    directory, manifest_path, out = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(manifest_path) as f:
        manifest = json.load(f)
    con = duckdb.connect()
    source = f"read_parquet('{directory}/**/*.parquet', union_by_name=true)"
    columns = [r[0] for r in con.sql(f"DESCRIBE SELECT * FROM {source}").fetchall()]
    recipe_col = "install_config" if "install_config" in columns else None
    licence_col = next((c for c in ("license_name", "license") if c in columns), None)
    picked = [f'"{c}"' for c in (recipe_col, licence_col) if c]
    rows = con.sql(f'SELECT instance_id, repo, CAST(created_at AS VARCHAR), {", ".join(picked) or "NULL"} FROM {source}').fetchall()

    repos, seen = {}, set()
    for row in rows:
        instance_id, repo, created_at = row[0], row[1], row[2] or ""
        if instance_id in seen:  # an instance in more than one file counts once
            continue
        seen.add(instance_id)
        rest = dict(zip([c for c in (recipe_col, licence_col) if c], row[3:]))
        entry = repos.setdefault(repo, {"repo": repo, "instances": 0, "newest": None, "recipe_instance": None, "recipe": None, "dataset_licence": None})
        entry["instances"] += 1
        recipe = recipe_of(rest.get(recipe_col)) if recipe_col else None
        key = (created_at, instance_id)
        if entry["newest"] is None or key > tuple(entry["newest"]):
            entry["newest"] = list(key)
            if licence_col and rest.get(licence_col):
                entry["dataset_licence"] = rest[licence_col]
        if recipe is not None and (entry["recipe_instance"] is None or key > tuple(entry["_recipe_key"])):
            entry["recipe"], entry["recipe_instance"], entry["_recipe_key"] = recipe, instance_id, list(key)

    listed = []
    for repo in sorted(repos):
        entry = repos[repo]
        entry.pop("_recipe_key", None)
        entry["newest_issue"] = entry.pop("newest")[0]
        listed.append(entry)
    with open(out, "w") as f:
        json.dump({**manifest, "recipe_column": recipe_col, "instances": len(seen), "repos": listed}, f, indent=1, default=str)
    no_recipe = sum(1 for r in listed if r["recipe"] is None)
    print(f"# Repository list from {manifest['dataset']} at {manifest['commit']}\n")
    print(f"- {len(seen)} instances, {len(listed)} repositories")
    print(f"- {no_recipe} repositories with no recipe" + ("" if recipe_col else " (the dataset has no install_config column)"))


if __name__ == "__main__":
    main()
