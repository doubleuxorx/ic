fn main() {
    let mut attributes = tauri_build::Attributes::new();

    // Embed the Windows application manifest by hand instead of letting
    // tauri-build do it. Tauri's menu and dialog code imports comctl32 v6 entry
    // points, which only resolve in a process whose manifest declares a
    // dependency on Common-Controls 6; tauri-build embeds that manifest through
    // embed-resource, which links it into binaries only. The test executable is
    // not a binary, so on Windows it failed to load at all — exit code
    // 0xc0000139, STATUS_ENTRYPOINT_NOT_FOUND, before a single test ran.
    // `cargo:rustc-link-arg` applies to every linked target, tests included.
    // Upstream: https://github.com/tauri-apps/tauri/issues/13419
    if target_is_windows_msvc() {
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());

        let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("windows-app-manifest.xml");

        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }

    tauri_build::try_build(attributes).expect("failed to build the Tauri application");
}

/// `/MANIFEST:EMBED` is an MSVC linker flag, so the manifest above is only for
/// that target. This reads the target rather than using `cfg!`, which describes
/// the machine the build script runs on.
fn target_is_windows_msvc() -> bool {
    std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
}
