use std::path::PathBuf;

use anyhow::{bail, Context};
use serde_json::Value;

use crate::shared::folder_index::{self, FieldOp, FilterSpec, QueryOptions, SortOrder};

/// Parse a single --filter JSON string into a FilterSpec.
fn parse_filter(raw: &str) -> anyhow::Result<FilterSpec> {
    let v: Value =
        serde_json::from_str(raw).with_context(|| format!("invalid filter JSON: {raw}"))?;
    let op = v
        .get("op")
        .and_then(Value::as_str)
        .with_context(|| format!("filter missing \"op\" field: {raw}"))?;

    match op {
        "hasWorking" => Ok(FilterSpec::HasWorking),
        "hasDirty" => Ok(FilterSpec::HasDirty),
        "hasMaster" => Ok(FilterSpec::HasMaster),
        "approvedChanges" => Ok(FilterSpec::ApprovedChanges),
        "unapprovedChanges" => Ok(FilterSpec::UnapprovedChanges),
        "hasErrors" => Ok(FilterSpec::HasErrors),
        "eq" | "lt" | "gt" | "contains" => {
            let field = v
                .get("field")
                .and_then(Value::as_str)
                .with_context(|| format!("filter missing \"field\": {raw}"))?
                .to_string();
            let value = v
                .get("value")
                .and_then(Value::as_str)
                .with_context(|| format!("filter missing \"value\": {raw}"))?
                .to_string();
            let field_op = match op {
                "eq" => FieldOp::Eq,
                "lt" => FieldOp::Lt,
                "gt" => FieldOp::Gt,
                "contains" => FieldOp::Contains,
                _ => unreachable!(),
            };
            Ok(FilterSpec::Field {
                column: field,
                op: field_op,
                value,
            })
        }
        other => bail!("unknown filter op {:?}: {raw}", other),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn run(
    workspace: &PathBuf,
    folder: &str,
    offset: i64,
    limit: i64,
    sort_by: &str,
    sort_order_str: &str,
    filter_strs: &[String],
    db_path: Option<&PathBuf>,
    reindex: bool,
    check: bool,
    debug: bool,
    validate: bool,
) -> anyhow::Result<()> {
    if limit < 1 || limit > 1000 {
        bail!("--limit must be between 1 and 1000 (got {limit})");
    }

    let sort_order = match sort_order_str {
        "asc" => SortOrder::Asc,
        "desc" => SortOrder::Desc,
        other => bail!("--sort-order must be \"asc\" or \"desc\" (got {:?})", other),
    };

    let mut filters = Vec::with_capacity(filter_strs.len());
    for raw in filter_strs {
        filters.push(parse_filter(raw)?);
    }

    let opts = QueryOptions {
        workspace: workspace.clone(),
        folder: folder.to_string(),
        offset,
        limit,
        sort_by: sort_by.to_string(),
        sort_order,
        filters,
        db_path_override: db_path.cloned(),
        reindex,
        debug,
        validate,
    };

    if check {
        let result = folder_index::run_check(&opts)?;
        println!(
            "{}",
            serde_json::to_string(&result).context("serialization error")?
        );
        return Ok(());
    }

    let result = folder_index::run_query(&opts)?;
    println!(
        "{}",
        serde_json::to_string(&result).context("serialization error")?
    );
    Ok(())
}
