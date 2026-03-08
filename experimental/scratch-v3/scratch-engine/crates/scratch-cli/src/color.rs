use std::io::IsTerminal;
use std::sync::OnceLock;

/// Returns true if output should use ANSI colors.
///
/// Colors are disabled when stdout is not a terminal (piped) or when
/// the NO_COLOR environment variable is set (https://no-color.org/).
fn use_color() -> bool {
    static USE_COLOR: OnceLock<bool> = OnceLock::new();
    *USE_COLOR.get_or_init(|| std::io::stdout().is_terminal() && std::env::var_os("NO_COLOR").is_none())
}

pub fn red() -> &'static str {
    if use_color() { "\x1b[31m" } else { "" }
}
pub fn green() -> &'static str {
    if use_color() { "\x1b[32m" } else { "" }
}
pub fn yellow() -> &'static str {
    if use_color() { "\x1b[33m" } else { "" }
}
pub fn magenta() -> &'static str {
    if use_color() { "\x1b[35m" } else { "" }
}
pub fn cyan() -> &'static str {
    if use_color() { "\x1b[36m" } else { "" }
}
pub fn reset() -> &'static str {
    if use_color() { "\x1b[0m" } else { "" }
}
