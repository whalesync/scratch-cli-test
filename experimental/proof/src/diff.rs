//! Word-level inline diffs, rendered as HTML spans the templates drop in via
//! `{{ change.diff_html | safe }}`. This is the one thing the templating layer
//! can't express on its own — so the engine pre-renders it and hands it over.

use similar::{capture_diff_slices, Algorithm, ChangeTag, DiffTag, TextDiff};

/// Renders a word-level diff between `published_value` and `working_value` as a
/// run of `<span>`s: unchanged words in `.d-eq`, removed words in `.d-del`,
/// added words in `.d-ins`. A field that only exists on one side (a freshly
/// added or removed field) falls out naturally — the empty side contributes no
/// words, so everything reads as a pure insert or delete.
pub fn inline_word_diff(published_value: &str, working_value: &str) -> String {
    let diff = TextDiff::from_words(published_value, working_value);
    let mut out = String::new();
    for change in diff.iter_all_changes() {
        let text = html_escape(change.value());
        match change.tag() {
            ChangeTag::Equal => {
                out.push_str("<span class=\"d-eq\">");
                out.push_str(&text);
                out.push_str("</span>");
            }
            ChangeTag::Delete => {
                out.push_str("<span class=\"d-del\">");
                out.push_str(&text);
                out.push_str("</span>");
            }
            ChangeTag::Insert => {
                out.push_str("<span class=\"d-ins\">");
                out.push_str(&text);
                out.push_str("</span>");
            }
        }
    }
    out
}

/// Renders `working` (an HTML fragment) with the runs that differ from
/// `published` wrapped in `<mark class="pk-change">` — in place, so an edited
/// blog body reads as the published article with its changed words highlighted
/// exactly where they are. HTML tags are kept atomic and never wrapped, so the
/// markup stays valid; pure deletions don't appear (we show the working side).
/// This is what lets the change minimap point at word-level edits inside a long
/// rendered post rather than at whole fields.
pub fn mark_changes(published: &str, working: &str) -> String {
    let published_atoms = tokenize_html(published);
    let working_atoms = tokenize_html(working);
    let ops = capture_diff_slices(Algorithm::Myers, &published_atoms, &working_atoms);

    let mut out = String::with_capacity(working.len() + 64);
    for op in ops {
        match op.tag() {
            DiffTag::Equal => {
                for atom in &working_atoms[op.new_range()] {
                    out.push_str(atom);
                }
            }
            // Pure insertion: highlight the new words.
            DiffTag::Insert => emit_changed_run(&mut out, &working_atoms[op.new_range()], None),
            // Replacement: highlight the new words, carrying the old text so a
            // hover can show what they replaced (struck through).
            DiffTag::Replace => {
                let removed = tooltip_text(&published_atoms[op.old_range()]);
                emit_changed_run(&mut out, &working_atoms[op.new_range()], Some(&removed));
            }
            // Pure deletion: nothing survives on the working side, so drop a red
            // caret carrying the removed text for the hover reveal.
            DiffTag::Delete => {
                let removed = tooltip_text(&published_atoms[op.old_range()]);
                if !removed.is_empty() {
                    out.push_str("<span class=\"pk-del\" data-del=\"");
                    out.push_str(&html_escape(&removed));
                    out.push_str("\"></span>");
                }
            }
        }
    }
    out
}

/// Emits a run of working atoms wrapped in `<mark class="pk-change">`, breaking
/// the mark around any HTML tag so the markup stays valid. `removed`, when
/// present, becomes a `data-del` attribute the hover tooltip reveals.
fn emit_changed_run(out: &mut String, atoms: &[String], removed: Option<&str>) {
    let open_tag = match removed.filter(|text| !text.is_empty()) {
        Some(text) => format!(
            "<mark class=\"pk-change\" data-del=\"{}\">",
            html_escape(text)
        ),
        None => "<mark class=\"pk-change\">".to_string(),
    };
    let mut inside_mark = false;
    for atom in atoms {
        if atom.starts_with('<') {
            if inside_mark {
                out.push_str("</mark>");
                inside_mark = false;
            }
            out.push_str(atom);
        } else {
            if !inside_mark {
                out.push_str(&open_tag);
                inside_mark = true;
            }
            out.push_str(atom);
        }
    }
    if inside_mark {
        out.push_str("</mark>");
    }
}

/// The visible text of a run of atoms (tags stripped, whitespace collapsed,
/// truncated), for a deletion/replacement hover tooltip.
fn tooltip_text(atoms: &[String]) -> String {
    let mut text = String::new();
    for atom in atoms {
        if !atom.starts_with('<') {
            text.push_str(atom);
        }
    }
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(160).collect()
}

/// Splits an HTML fragment into diff atoms: each tag (`<...>`) is one atom; the
/// text between tags is split into word and whitespace runs so the diff lands at
/// word granularity.
fn tokenize_html(input: &str) -> Vec<String> {
    let mut atoms = Vec::new();
    let mut rest = input;
    while !rest.is_empty() {
        if rest.starts_with('<') {
            match rest.find('>') {
                Some(end) => {
                    atoms.push(rest[..=end].to_string());
                    rest = &rest[end + 1..];
                }
                None => {
                    atoms.push(rest.to_string());
                    break;
                }
            }
        } else {
            let end = rest.find('<').unwrap_or(rest.len());
            push_word_atoms(&rest[..end], &mut atoms);
            rest = &rest[end..];
        }
    }
    atoms
}

fn push_word_atoms(text: &str, atoms: &mut Vec<String>) {
    let mut current = String::new();
    let mut current_is_whitespace: Option<bool> = None;
    for ch in text.chars() {
        let is_whitespace = ch.is_whitespace();
        if current_is_whitespace.is_some() && current_is_whitespace != Some(is_whitespace) {
            atoms.push(std::mem::take(&mut current));
        }
        current.push(ch);
        current_is_whitespace = Some(is_whitespace);
    }
    if !current.is_empty() {
        atoms.push(current);
    }
}

#[cfg(test)]
mod tests {
    use super::mark_changes;

    #[test]
    fn highlights_insertions() {
        let html = mark_changes("the dog", "the big dog");
        assert!(html.contains("pk-change"), "{html}");
        assert!(html.contains("big"), "{html}");
        assert!(!html.contains("pk-del"), "{html}");
    }

    #[test]
    fn drops_a_caret_for_pure_deletions() {
        let html = mark_changes("the big dog runs", "the dog runs");
        assert!(
            html.contains("class=\"pk-del\""),
            "missing delete caret: {html}"
        );
        assert!(
            html.contains("data-del=\"big\""),
            "missing deleted text: {html}"
        );
        assert!(html.contains("the"), "{html}");
        assert!(html.contains("dog"), "{html}");
    }

    #[test]
    fn replacement_carries_the_old_text() {
        let html = mark_changes("export to CSV", "export to spreadsheet");
        assert!(html.contains("pk-change"), "{html}");
        assert!(html.contains("data-del=\"CSV\""), "{html}");
        assert!(html.contains("spreadsheet"), "{html}");
    }

    #[test]
    fn never_wraps_html_tags() {
        let html = mark_changes("<p>old text here</p>", "<p>new text here</p>");
        // the <p> tags must be emitted outside any <mark>
        assert!(html.contains("<p>"), "{html}");
        assert!(!html.contains("<mark class=\"pk-change\"><p>"), "{html}");
        assert!(!html.contains("</p></mark>"), "{html}");
    }
}

/// Minimal HTML-attribute/text escaping. We control the call sites, so the small
/// fixed set below covers everything that can break out of the markup.
pub fn html_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            other => out.push(other),
        }
    }
    out
}
