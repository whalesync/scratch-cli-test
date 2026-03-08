"""JSON ↔ CSV/Markdown round-trip tool.

Auto-discovers editable fields in a folder of JSON records,
exports to CSV or Markdown for human editing, and merges
edits back into the original JSON — preserving all nested
structures, types, and fields that weren't exported.

No configuration required. The JSON structure is the schema.
"""

import argparse
import csv
import json
import shutil
import sys
from pathlib import Path

MAX_STR_LEN = 500
LIST_SEP = " | "


def leaf_paths(obj, prefix=""):
    """Walk a JSON object, yield (dot_path, value) for editable leaves."""
    if not isinstance(obj, dict):
        return
    for key, val in obj.items():
        path = f"{prefix}.{key}" if prefix else key
        if val is None or isinstance(val, (int, float, bool)):
            yield path, val
        elif isinstance(val, str):
            if len(val) <= MAX_STR_LEN:
                yield path, val
        elif isinstance(val, dict):
            yield from leaf_paths(val, prefix=path)
        elif isinstance(val, list):
            if val and all(isinstance(v, (str, int, float, bool)) for v in val):
                yield path, val
            # else: array of objects or mixed → skip


def format_value(val):
    """Convert a Python value to a CSV-safe string."""
    if val is None:
        return ""
    if isinstance(val, bool):
        return str(val).lower()
    if isinstance(val, list):
        return LIST_SEP.join(str(v) for v in val)
    return str(val)


def get_at_path(obj, dot_path):
    """Walk a dot-path into a nested dict. Returns (found, value)."""
    parts = dot_path.split(".")
    current = obj
    for part in parts:
        if not isinstance(current, dict) or part not in current:
            return False, None
        current = current[part]
    return True, current


def set_at_path(obj, dot_path, value):
    """Set a value at a dot-path in a nested dict. Path must already exist."""
    parts = dot_path.split(".")
    current = obj
    for part in parts[:-1]:
        if not isinstance(current, dict) or part not in current:
            return False
        current = current[part]
    if not isinstance(current, dict) or parts[-1] not in current:
        return False
    current[parts[-1]] = value
    return True


def coerce(edited_str, original_value):
    """Coerce an edited CSV string back to the original value's type."""
    if original_value is None:
        if edited_str == "":
            return None
        return edited_str

    if isinstance(original_value, bool):
        return edited_str.lower() in ("true", "1", "yes")

    if isinstance(original_value, int):
        if edited_str == "":
            return original_value  # don't destroy on ambiguous empty
        return int(edited_str)

    if isinstance(original_value, float):
        if edited_str == "":
            return original_value  # don't destroy on ambiguous empty
        return float(edited_str)

    if isinstance(original_value, list):
        if edited_str == "":
            return []
        parts = [s.strip() for s in edited_str.split(LIST_SEP.strip())]
        # coerce list elements to match original element types
        if original_value:
            elem_type = type(original_value[0])
            if elem_type == int:
                return [int(p) for p in parts]
            if elem_type == float:
                return [float(p) for p in parts]
            if elem_type == bool:
                return [p.lower() in ("true", "1", "yes") for p in parts]
        return parts

    return edited_str


def is_exportable(val):
    """Check if a value is suitable for CSV export."""
    if isinstance(val, str) and len(val) > MAX_STR_LEN:
        return False
    if isinstance(val, list) and any(isinstance(v, dict) for v in val):
        return False
    return True


def discover_columns(json_dir):
    """Discover all leaf paths across all JSON files in a directory.

    A path is included only if the majority of records that contain it
    have values short enough for CSV.
    """
    path_ok = {}   # path → [True/False per record that has it]
    order = {}     # path → first-seen index

    for json_file in sorted(Path(json_dir).glob("*.json")):
        with open(json_file) as f:
            record = json.load(f)
        # check all potential paths, not just those that pass leaf_paths filter
        for path, val in _all_leaf_paths(record):
            if path not in order:
                order[path] = len(order)
            path_ok.setdefault(path, []).append(is_exportable(val))

    # include path if >50% of records with it have exportable values
    columns = []
    for path in sorted(order, key=order.get):
        checks = path_ok[path]
        if sum(checks) > len(checks) / 2:
            columns.append(path)
    return columns


def _all_leaf_paths(obj, prefix=""):
    """Like leaf_paths but yields ALL leaves including long strings."""
    if not isinstance(obj, dict):
        return
    for key, val in obj.items():
        path = f"{prefix}.{key}" if prefix else key
        if val is None or isinstance(val, (int, float, bool, str)):
            yield path, val
        elif isinstance(val, dict):
            yield from _all_leaf_paths(val, prefix=path)
        elif isinstance(val, list):
            yield path, val  # let is_exportable decide


def discover_array_field(json_dir):
    """Find the best array-of-objects field to denormalize on.

    Picks the field with the most total elements across all records.
    Returns (field_name, total_elements) or (None, 0).
    """
    from collections import Counter
    counts = Counter()
    for json_file in sorted(Path(json_dir).glob("*.json")):
        with open(json_file) as f:
            record = json.load(f)
        for key, val in record.items():
            if isinstance(val, list) and val and isinstance(val[0], dict):
                counts[key] += len(val)
    if not counts:
        return None, 0
    field, total = counts.most_common(1)[0]
    return field, total


def discover_sub_columns(json_dir, array_field):
    """Discover exportable leaf paths within sub-objects of an array field."""
    path_ok = {}
    order = {}
    for json_file in sorted(Path(json_dir).glob("*.json")):
        with open(json_file) as f:
            record = json.load(f)
        for item in record.get(array_field, []):
            if not isinstance(item, dict):
                continue
            for path, val in _all_leaf_paths(item):
                if path not in order:
                    order[path] = len(order)
                path_ok.setdefault(path, []).append(is_exportable(val))
    columns = []
    for path in sorted(order, key=order.get):
        checks = path_ok[path]
        if sum(checks) > len(checks) / 2:
            columns.append(path)
    return columns


def detect_file_key(json_dir, columns):
    """Detect which column's values match the JSON filenames.

    Returns the column name, or None if no match found.
    """
    stems = {}  # stem → record
    for json_file in sorted(Path(json_dir).glob("*.json")):
        with open(json_file) as f:
            stems[json_file.stem] = json.load(f)

    for col in columns:
        matches = 0
        for stem, record in stems.items():
            found, val = get_at_path(record, col)
            if found and str(val) == stem:
                matches += 1
        if matches == len(stems):
            return col
    return None


def detect_element_key(json_dir, array_field, sub_columns):
    """Detect which sub-column uniquely identifies array elements.

    Returns the sub-column name (without array prefix), or None.
    """
    for col in sub_columns:
        all_unique = True
        for json_file in sorted(Path(json_dir).glob("*.json")):
            with open(json_file) as f:
                record = json.load(f)
            arr = record.get(array_field, [])
            vals = []
            for item in arr:
                found, val = get_at_path(item, col)
                if found:
                    vals.append(val)
            if len(vals) != len(set(str(v) for v in vals)):
                all_unique = False
                break
        if all_unique:
            return col
    return None


def build_file_index(json_dir, file_key):
    """Build a mapping from file_key values to (stem, record)."""
    index = {}
    for json_file in sorted(Path(json_dir).glob("*.json")):
        with open(json_file) as f:
            record = json.load(f)
        found, val = get_at_path(record, file_key)
        if found:
            index[str(val)] = (json_file.stem, record)
    return index


def discover_body_field(json_dir):
    """Find the most common long-string field across all records.

    Returns the dot-path of the field, or None if no long strings exist.
    """
    from collections import Counter
    counts = Counter()
    total = 0
    for json_file in sorted(Path(json_dir).glob("*.json")):
        total += 1
        with open(json_file) as f:
            record = json.load(f)
        for path, val in _all_leaf_paths(record):
            if isinstance(val, str) and len(val) > MAX_STR_LEN:
                counts[path] += 1
    if not counts:
        return None
    # pick the field present in the most records
    return counts.most_common(1)[0][0]


# --- Frontmatter serialization ---

def _fm_quote(val_str):
    """Quote a frontmatter value if it contains ambiguous characters."""
    if not val_str:
        return '""'
    needs_quote = (
        "\n" in val_str
        or val_str.startswith('"')
        or val_str.startswith("'")
        or ": " in val_str
        or val_str.startswith("- ")
        or val_str in ("true", "false", "null")
    )
    if needs_quote:
        escaped = (val_str
                   .replace("\\", "\\\\")
                   .replace('"', '\\"')
                   .replace("\n", "\\n"))
        return f'"{escaped}"'
    return val_str


def write_frontmatter(fields, body_field=None, body=""):
    """Serialize fields dict + body into a markdown string with frontmatter."""
    lines = ["---"]
    for key, val in fields.items():
        lines.append(f"{key}: {_fm_quote(val)}")
    if body_field:
        lines.append(f"_body_field: {body_field}")
    lines.append("---")
    # body goes directly after ---, separated by exactly one newline
    return "\n".join(lines) + "\n" + body + "\n"


def read_frontmatter(text):
    """Parse a markdown string into (fields_dict, body_str, body_field_name)."""
    # split on --- markers
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}, text, None

    fm_text = parts[1].strip()
    # strip exactly one newline between --- and body
    body = parts[2][1:] if parts[2].startswith("\n") else parts[2]

    fields = {}
    body_field = None
    for line in fm_text.split("\n"):
        line = line.strip()
        if not line:
            continue
        sep = line.find(": ")
        if sep == -1:
            continue
        key = line[:sep]
        val = line[sep + 2:]
        # unquote if quoted
        if val.startswith('"') and val.endswith('"'):
            val = (val[1:-1]
                   .replace("\\n", "\n")
                   .replace('\\"', '"')
                   .replace("\\\\", "\\"))
        if key == "_body_field":
            body_field = val
        else:
            fields[key] = val

    return fields, body, body_field


# --- CSV export/merge ---

def export(json_dir, csv_path):
    """Export a folder of JSON records to a single CSV file."""
    json_dir = Path(json_dir)
    columns = discover_columns(json_dir)
    if not columns:
        print("No exportable columns found.", file=sys.stderr)
        sys.exit(1)

    file_key = detect_file_key(json_dir, columns)

    json_files = sorted(json_dir.glob("*.json"))
    print(f"Exporting {len(json_files)} records, {len(columns)} columns"
          + (f", key: {file_key}" if file_key else ", key: _file (no matching column)"))

    with open(csv_path, "w", newline="") as f:
        writer = csv.writer(f)
        header = columns if file_key else ["_file"] + columns
        writer.writerow(header)
        for json_file in json_files:
            with open(json_file) as jf:
                record = json.load(jf)
            row = [] if file_key else [json_file.stem]
            for col in columns:
                found, val = get_at_path(record, col)
                if found and is_exportable(val):
                    row.append(format_value(val))
                else:
                    row.append("")
            writer.writerow(row)

    print(f"Wrote {csv_path}")


def merge(csv_path, json_dir, output_dir):
    """Merge an edited CSV back into the original JSON records."""
    json_dir = Path(json_dir)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    with open(csv_path, newline="") as f:
        reader = csv.DictReader(f)
        all_columns = list(reader.fieldnames)
        rows = list(reader)

    # detect file key: _file column or auto-detect from data
    if "_file" in all_columns:
        file_key = "_file"
        columns = [c for c in all_columns if c != "_file"]
    else:
        columns = all_columns
        file_key = detect_file_key(json_dir, columns)
        if not file_key:
            print("Cannot detect which column matches filenames.", file=sys.stderr)
            sys.exit(1)

    # build index: key_value → (stem, record)
    file_index = build_file_index(json_dir, file_key) if file_key != "_file" else None

    csv_stems = set()
    changes = 0

    for row in rows:
        if file_key == "_file":
            stem = row["_file"]
        else:
            key_val = row[file_key]
            if key_val not in file_index:
                print(f"  SKIP {file_key}={key_val}: not found", file=sys.stderr)
                continue
            stem = file_index[key_val][0]

        csv_stems.add(stem)
        src = json_dir / f"{stem}.json"
        dst = output_dir / f"{stem}.json"

        if not src.exists():
            print(f"  SKIP {stem}: not found in {json_dir}", file=sys.stderr)
            continue

        with open(src) as f:
            record = json.load(f)

        record_changes = 0
        for col in columns:
            edited_str = row[col]
            found, original_val = get_at_path(record, col)
            if not found:
                continue

            original_str = format_value(original_val)
            if edited_str == original_str:
                continue

            if edited_str == "" and not isinstance(original_val, str):
                continue

            new_val = coerce(edited_str, original_val)
            set_at_path(record, col, new_val)
            record_changes += 1

        if record_changes:
            print(f"  {stem}: {record_changes} field(s) changed")
            changes += record_changes

        with open(dst, "w") as f:
            json.dump(record, f, indent=2, ensure_ascii=False)
            f.write("\n")

    # copy over any JSON files not in the CSV (unchanged)
    for json_file in sorted(json_dir.glob("*.json")):
        if json_file.stem not in csv_stems:
            dst = output_dir / json_file.name
            if not dst.exists():
                shutil.copy2(json_file, dst)

    print(f"Merged {len(rows)} records ({changes} total changes) → {output_dir}")


# --- Markdown export/merge ---

def export_md(json_dir, md_dir):
    """Export a folder of JSON records to individual Markdown files."""
    json_dir = Path(json_dir)
    md_dir = Path(md_dir)
    md_dir.mkdir(parents=True, exist_ok=True)

    columns = discover_columns(json_dir)
    body_field = discover_body_field(json_dir)

    json_files = sorted(json_dir.glob("*.json"))
    print(f"Exporting {len(json_files)} records, {len(columns)} fields"
          + (f", body: {body_field}" if body_field else ""))

    for json_file in json_files:
        with open(json_file) as f:
            record = json.load(f)

        fields = {}
        for col in columns:
            found, val = get_at_path(record, col)
            if found and is_exportable(val):
                fields[col] = format_value(val)
            else:
                fields[col] = ""

        body = ""
        if body_field:
            found, val = get_at_path(record, body_field)
            if found and isinstance(val, str):
                body = val

        md_path = md_dir / f"{json_file.stem}.md"
        md_path.write_bytes(write_frontmatter(fields, body_field, body).encode("utf-8"))

    print(f"Wrote {len(json_files)} files → {md_dir}")


def merge_md(md_dir, json_dir, output_dir):
    """Merge edited Markdown files back into the original JSON records."""
    json_dir = Path(json_dir)
    md_dir = Path(md_dir)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    md_files = sorted(md_dir.glob("*.md"))
    md_stems = {f.stem for f in md_files}
    changes = 0

    for md_file in md_files:
        stem = md_file.stem
        src = json_dir / f"{stem}.json"
        dst = output_dir / f"{stem}.json"

        if not src.exists():
            print(f"  SKIP {stem}: not found in {json_dir}", file=sys.stderr)
            continue

        with open(src) as f:
            record = json.load(f)

        fields, body, body_field = read_frontmatter(md_file.read_bytes().decode("utf-8"))

        record_changes = 0

        # merge frontmatter fields
        for col, edited_str in fields.items():
            found, original_val = get_at_path(record, col)
            if not found:
                continue

            original_str = format_value(original_val)
            if edited_str == original_str:
                continue

            if edited_str == "" and not isinstance(original_val, str):
                continue

            new_val = coerce(edited_str, original_val)
            set_at_path(record, col, new_val)
            record_changes += 1

        # merge body
        if body_field:
            found, original_body = get_at_path(record, body_field)
            if found and isinstance(original_body, str):
                # strip the single trailing newline added by write_frontmatter
                edited_body = body[:-1] if body.endswith("\n") else body
                if edited_body != original_body:
                    set_at_path(record, body_field, edited_body)
                    record_changes += 1

        if record_changes:
            print(f"  {stem}: {record_changes} field(s) changed")
            changes += record_changes

        with open(dst, "w") as f:
            json.dump(record, f, indent=2, ensure_ascii=False)
            f.write("\n")

    # copy over JSON files not in the markdown set
    for json_file in sorted(json_dir.glob("*.json")):
        if json_file.stem not in md_stems:
            dst = output_dir / json_file.name
            if not dst.exists():
                shutil.copy2(json_file, dst)

    print(f"Merged {len(md_files)} records ({changes} total changes) → {output_dir}")


# --- Flat (denormalized) export/merge ---

def export_flat(json_dir, csv_path, array_field=None):
    """Export JSON records denormalized: one row per array element."""
    json_dir = Path(json_dir)

    if not array_field:
        array_field, total = discover_array_field(json_dir)
        if not array_field:
            print("No array-of-objects fields found.", file=sys.stderr)
            sys.exit(1)

    parent_columns = discover_columns(json_dir)
    sub_columns = discover_sub_columns(json_dir, array_field)
    sub_headers = [f"{array_field}.{c}" for c in sub_columns]

    element_key = detect_element_key(json_dir, array_field, sub_columns)
    file_key = detect_file_key(json_dir, parent_columns)

    json_files = sorted(json_dir.glob("*.json"))
    row_count = 0

    with open(csv_path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(parent_columns + sub_headers)

        for json_file in json_files:
            with open(json_file) as jf:
                record = json.load(jf)

            arr = record.get(array_field, [])
            if not arr:
                row = []
                for col in parent_columns:
                    found, val = get_at_path(record, col)
                    row.append(format_value(val) if found and is_exportable(val) else "")
                row.extend([""] * len(sub_columns))
                writer.writerow(row)
                row_count += 1
            else:
                for item in arr:
                    row = []
                    for col in parent_columns:
                        found, val = get_at_path(record, col)
                        row.append(format_value(val) if found and is_exportable(val) else "")
                    for col in sub_columns:
                        found, val = get_at_path(item, col)
                        row.append(format_value(val) if found and is_exportable(val) else "")
                    writer.writerow(row)
                    row_count += 1

    print(f"Exported {len(json_files)} records × {array_field}"
          f" = {row_count} rows, {len(parent_columns)} parent"
          f" + {len(sub_columns)} {array_field} columns")
    print(f"  file key: {file_key or '(none)'}"
          f", element key: {array_field}.{element_key or '(none)'}")
    print(f"Wrote {csv_path}")


def merge_flat(csv_path, json_dir, output_dir):
    """Merge a denormalized CSV back into JSON. Force sameness on parent fields."""
    json_dir = Path(json_dir)
    output_dir = Path(output_dir)

    with open(csv_path, newline="") as f:
        reader = csv.DictReader(f)
        all_columns = list(reader.fieldnames)
        rows = list(reader)

    # detect array field and split parent vs sub columns using sample record
    sample_file = sorted(Path(json_dir).glob("*.json"))[0]
    with open(sample_file) as f:
        sample = json.load(f)

    array_field = None
    parent_cols = []
    sub_col_map = {}  # csv_header → sub_path

    for col in all_columns:
        dot = col.find(".")
        if dot != -1:
            prefix = col[:dot]
            val = sample.get(prefix)
            if isinstance(val, list) and val and isinstance(val[0], dict):
                array_field = prefix
                sub_col_map[col] = col[dot + 1:]
                continue
        parent_cols.append(col)

    # detect file key and element key
    file_key = detect_file_key(json_dir, parent_cols)
    if not file_key:
        print("Cannot detect which column matches filenames.", file=sys.stderr)
        sys.exit(1)

    element_key = None
    element_key_col = None
    if array_field:
        element_key = detect_element_key(json_dir, array_field, list(sub_col_map.values()))
        element_key_col = f"{array_field}.{element_key}" if element_key else None

    # build file index and group rows by file key
    file_index = build_file_index(json_dir, file_key)
    groups = {}
    for row in rows:
        key_val = row[file_key]
        groups.setdefault(key_val, []).append(row)

    # process records
    results = []
    errors = []
    total_changes = 0

    for key_val, file_rows in sorted(groups.items()):
        if key_val not in file_index:
            print(f"  SKIP {file_key}={key_val}: not found", file=sys.stderr)
            continue

        stem, record = file_index[key_val]
        # reload since we might modify it
        with open(json_dir / f"{stem}.json") as f:
            record = json.load(f)

        # force sameness check on parent columns
        for col in parent_cols:
            values = set(row[col] for row in file_rows)
            if len(values) > 1:
                errors.append(f"  {stem}: '{col}' has conflicting values: {values}")

        record_changes = 0

        # merge parent-level fields (all rows same, use first)
        row0 = file_rows[0]
        for col in parent_cols:
            edited_str = row0[col]
            found, original_val = get_at_path(record, col)
            if not found:
                continue
            original_str = format_value(original_val)
            if edited_str == original_str:
                continue
            if edited_str == "" and not isinstance(original_val, str):
                continue
            new_val = coerce(edited_str, original_val)
            set_at_path(record, col, new_val)
            record_changes += 1

        # merge sub-object fields
        if array_field:
            arr = record.get(array_field, [])

            # build element index by key
            if element_key:
                elem_by_key = {}
                for item in arr:
                    found, val = get_at_path(item, element_key)
                    if found:
                        elem_by_key[str(val)] = item

            for row in file_rows:
                # find the matching array element
                item = None
                if element_key and element_key_col:
                    row_key = row.get(element_key_col, "")
                    item = elem_by_key.get(row_key)
                if not item:
                    continue

                for csv_col, sub_path in sub_col_map.items():
                    edited_str = row[csv_col]
                    found, original_val = get_at_path(item, sub_path)
                    if not found:
                        continue
                    original_str = format_value(original_val)
                    if edited_str == original_str:
                        continue
                    if edited_str == "" and not isinstance(original_val, str):
                        continue
                    new_val = coerce(edited_str, original_val)
                    set_at_path(item, sub_path, new_val)
                    record_changes += 1

        if record_changes:
            print(f"  {stem}: {record_changes} field(s) changed")
        total_changes += record_changes
        results.append((stem, record))

    # abort on conflicts
    if errors:
        print(f"\nCONFLICT — parent fields must match on all rows for a record:",
              file=sys.stderr)
        for err in errors:
            print(err, file=sys.stderr)
        print(f"\n{len(errors)} conflict(s). No files written.", file=sys.stderr)
        sys.exit(1)

    # write results
    output_dir.mkdir(parents=True, exist_ok=True)
    written_stems = set()
    for stem, record in results:
        dst = output_dir / f"{stem}.json"
        with open(dst, "w") as f:
            json.dump(record, f, indent=2, ensure_ascii=False)
            f.write("\n")
        written_stems.add(stem)

    # copy unchanged files
    for json_file in sorted(json_dir.glob("*.json")):
        if json_file.stem not in written_stems:
            dst = output_dir / json_file.name
            if not dst.exists():
                shutil.copy2(json_file, dst)

    print(f"Merged {len(groups)} records ({total_changes} total changes) → {output_dir}")


def export_records(records: list[dict], names: list[str]) -> str:
    """Export a list of parsed record dicts to a CSV string.

    Args:
        records: list of parsed JSON record dicts
        names: list of filenames/stems corresponding to each record

    Returns:
        CSV string with _file column + all discovered leaf columns
    """
    from io import StringIO

    # discover columns across all records
    path_ok = {}
    order = {}
    for record in records:
        for path, val in _all_leaf_paths(record):
            if path not in order:
                order[path] = len(order)
            path_ok.setdefault(path, []).append(is_exportable(val))

    columns = []
    for path in sorted(order, key=order.get):
        checks = path_ok[path]
        if sum(checks) > len(checks) / 2:
            columns.append(path)

    buf = StringIO()
    writer = csv.writer(buf)
    writer.writerow(["_file"] + columns)
    for name, record in zip(names, records):
        row = [name]
        for col in columns:
            found, val = get_at_path(record, col)
            if found and is_exportable(val):
                row.append(format_value(val))
            else:
                row.append("")
        writer.writerow(row)

    return buf.getvalue()


def merge_records(csv_string: str, originals: dict[str, dict]) -> list[tuple[str, dict, int]]:
    """Merge an edited CSV string back into original records.

    Args:
        csv_string: CSV content with _file column
        originals: dict mapping stem → original parsed record dict

    Returns:
        list of (stem, updated_record, change_count) for records with changes
    """
    import copy
    from io import StringIO

    # Strip BOM that spreadsheet apps (Excel, Numbers) prepend to CSV
    if csv_string.startswith("\ufeff"):
        csv_string = csv_string[1:]

    reader = csv.DictReader(StringIO(csv_string))
    all_columns = list(reader.fieldnames or [])
    columns = [c for c in all_columns if c != "_file"]
    debug = []

    results = []
    for row in reader:
        stem = row.get("_file", "")
        if stem not in originals:
            continue

        record = copy.deepcopy(originals[stem])
        record_changes = 0

        for col in columns:
            edited_str = row[col].replace("\r\n", "\n")
            found, original_val = get_at_path(record, col)
            if not found:
                continue

            original_str = format_value(original_val)
            if edited_str == original_str:
                continue

            if edited_str == "" and not isinstance(original_val, str):
                continue

            new_val = coerce(edited_str, original_val)
            if new_val == original_val:
                continue
            set_at_path(record, col, new_val)
            record_changes += 1

        if record_changes:
            results.append((stem, record, record_changes))

    return results


EPILOG = """
examples:
  %(prog)s export     products/                  # → products.csv
  %(prog)s merge      products.csv products/     # → updates products/*.json
  %(prog)s export-md  posts/                     # → posts_md/*.md
  %(prog)s merge-md   posts_md/ posts/           # → updates posts/*.json
  %(prog)s export-flat products/                  # → products_flat.csv (one row per variant)
  %(prog)s merge-flat products_flat.csv products/ # → updates products/*.json

how it works:
  export     Walks each JSON file, auto-discovers flat/scalar fields,
             writes one CSV row per record. Skips arrays of objects
             and long strings (>500 chars).

  merge      Diffs the edited CSV against what export would produce.
             Only changed cells are written back. Types are preserved
             by inspecting the original JSON value at each path.

  export-md  Like export, but one .md file per record. Frontmatter
             holds the short fields; the body holds the longest text
             field (e.g. body_html, content.rendered).

  export-flat  Denormalizes one array-of-objects field (auto-detected,
             e.g. variants). One row per array element, parent fields
             repeated. Editing parent fields requires all rows for
             that record to agree (force sameness).

  All merge commands require the original JSON directory — edits are
  diffed against it, and unmodified fields are preserved exactly.
"""


def main():
    parser = argparse.ArgumentParser(
        description="JSON ↔ CSV/Markdown round-trip tool. No config required.",
        epilog=EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command")

    p = sub.add_parser("export",
        help="JSON → CSV (one row per record, flat fields only)")
    p.add_argument("json_dir", help="directory of .json files")
    p.add_argument("csv_path", nargs="?", help="output path (default: <dir>.csv)")

    p = sub.add_parser("merge",
        help="edited CSV → JSON (update original records)")
    p.add_argument("csv_path", help="edited CSV file")
    p.add_argument("json_dir", help="directory of original .json files")
    p.add_argument("output_dir", nargs="?", help="output dir (default: overwrite originals)")

    p = sub.add_parser("export-md",
        help="JSON → Markdown (one .md per record, frontmatter + body)")
    p.add_argument("json_dir", help="directory of .json files")
    p.add_argument("md_dir", nargs="?", help="output dir (default: <dir>_md)")

    p = sub.add_parser("merge-md",
        help="edited Markdown → JSON (update original records)")
    p.add_argument("md_dir", help="directory of edited .md files")
    p.add_argument("json_dir", help="directory of original .json files")
    p.add_argument("output_dir", nargs="?", help="output dir (default: overwrite originals)")

    p = sub.add_parser("export-flat",
        help="JSON → CSV denormalized (one row per array element)")
    p.add_argument("json_dir", help="directory of .json files")
    p.add_argument("csv_path", nargs="?", help="output path (default: <dir>_flat.csv)")
    p.add_argument("--array", help="array field to expand (auto-detected if omitted)")

    p = sub.add_parser("merge-flat",
        help="edited denormalized CSV → JSON (force sameness on parent fields)")
    p.add_argument("csv_path", help="edited CSV file")
    p.add_argument("json_dir", help="directory of original .json files")
    p.add_argument("output_dir", nargs="?", help="output dir (default: overwrite originals)")

    args = parser.parse_args()

    if args.command == "export":
        csv_path = args.csv_path or f"{args.json_dir.rstrip('/')}.csv"
        export(args.json_dir, csv_path)

    elif args.command == "merge":
        output_dir = args.output_dir or args.json_dir
        merge(args.csv_path, args.json_dir, output_dir)

    elif args.command == "export-md":
        md_dir = args.md_dir or f"{args.json_dir.rstrip('/')}_md"
        export_md(args.json_dir, md_dir)

    elif args.command == "merge-md":
        output_dir = args.output_dir or args.json_dir
        merge_md(args.md_dir, args.json_dir, output_dir)

    elif args.command == "export-flat":
        csv_path = args.csv_path or f"{args.json_dir.rstrip('/')}_flat.csv"
        export_flat(args.json_dir, csv_path, args.array)

    elif args.command == "merge-flat":
        output_dir = args.output_dir or args.json_dir
        merge_flat(args.csv_path, args.json_dir, output_dir)

    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
