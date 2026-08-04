//! Opening things outside the application.
//!
//! No shell is ever involved: the platform opener is executed directly with a
//! single argument list. URLs are restricted to a small scheme allowlist and
//! rejected if they could be mistaken for a command-line option.

use std::process::Command;

use tauri::State;

use crate::security::SecurityError;
use crate::workspace::WorkspaceState;

const MAX_URL_LEN: usize = 2048;
const ALLOWED_SCHEMES: [&str; 3] = ["https://", "http://", "mailto:"];

fn validate_url(url: &str) -> Result<(), SecurityError> {
    if url.len() > MAX_URL_LEN {
        return Err(SecurityError::UnsupportedFile("url is too long".into()));
    }
    if url.starts_with('-') {
        return Err(SecurityError::UnsupportedFile(
            "url must not start with a dash".into(),
        ));
    }
    if url
        .chars()
        .any(|c| c.is_control() || c == '\n' || c == '\r' || c == '"' || c == '\'')
    {
        return Err(SecurityError::UnsupportedFile(
            "url contains control characters".into(),
        ));
    }
    let lowered = url.to_lowercase();
    if !ALLOWED_SCHEMES
        .iter()
        .any(|scheme| lowered.starts_with(scheme))
    {
        return Err(SecurityError::UnsupportedFile(format!(
            "unsupported url scheme in {url}"
        )));
    }
    Ok(())
}

fn spawn_opener(argument: &std::ffi::OsStr, reveal: bool) -> Result<(), SecurityError> {
    #[cfg(target_os = "linux")]
    let mut command = {
        let mut c = Command::new("xdg-open");
        c.arg(argument);
        c
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut c = Command::new("open");
        if reveal {
            c.arg("-R");
        }
        c.arg(argument);
        c
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut c = Command::new("explorer.exe");
        if reveal {
            let mut select = std::ffi::OsString::from("/select,");
            select.push(argument);
            c.arg(select);
        } else {
            c.arg(argument);
        }
        c
    };

    #[cfg(target_os = "linux")]
    let _ = reveal;

    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|err| SecurityError::Io(err.to_string()))?;
    Ok(())
}

#[tauri::command]
pub fn external_open_url(url: String) -> Result<(), SecurityError> {
    validate_url(&url)?;
    spawn_opener(std::ffi::OsStr::new(&url), false)
}

#[tauri::command]
pub fn external_open_path(
    state: State<'_, WorkspaceState>,
    relative_path: String,
) -> Result<(), SecurityError> {
    let resolved = state.resolve(&relative_path)?;
    if !resolved.absolute.exists() {
        return Err(SecurityError::NotFound);
    }
    spawn_opener(resolved.absolute.as_os_str(), false)
}

#[tauri::command]
pub fn reveal_in_file_manager(
    state: State<'_, WorkspaceState>,
    relative_path: String,
) -> Result<(), SecurityError> {
    let resolved = state.resolve(&relative_path)?;
    if !resolved.absolute.exists() {
        return Err(SecurityError::NotFound);
    }
    // On Linux there is no portable "reveal", so the containing directory opens.
    #[cfg(target_os = "linux")]
    let target = resolved
        .absolute
        .parent()
        .unwrap_or(&resolved.absolute)
        .to_path_buf();
    #[cfg(not(target_os = "linux"))]
    let target = resolved.absolute.clone();

    spawn_opener(target.as_os_str(), true)
}

#[cfg(test)]
mod tests {
    use super::validate_url;

    #[test]
    fn accepts_ordinary_urls() {
        assert!(validate_url("https://example.org/path?q=1").is_ok());
        assert!(validate_url("mailto:someone@example.org").is_ok());
    }

    #[test]
    fn rejects_dangerous_urls() {
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<script>",
            "-hello",
            "https://example.org/\nrm -rf",
            "smb://host/share",
        ] {
            assert!(validate_url(url).is_err(), "should reject {url}");
        }
    }
}
