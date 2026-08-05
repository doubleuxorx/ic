# Vendored dependencies

Crates here are patched copies of published crates, wired in through
`[patch.crates-io]` in `../Cargo.toml`. They exist only because upstream has no
release we can consume; nothing in this directory is our own code, and it is
excluded from the cargo workspace so `cargo fmt`, `cargo clippy` and
`cargo test` never descend into it.

## glib-0.18.5

Fixes RUSTSEC-2024-0429 (GHSA-wrw7-89jp-8q8g), unsoundness in the `Iterator` and
`DoubleEndedIterator` impls for `glib::VariantStrIter`.

`VariantStrIter::impl_get` passed a `*mut c_char` out-argument to the variadic
`g_variant_get_child` as `&p` rather than `&mut p`. Recent rustc versions
discard the write C makes through that shared reference when optimizations are
on, so `CStr::from_ptr` then dereferences a NULL pointer.

Upstream fixed this in gtk-rs-core commit `b5a4071e43`, released in glib 0.20.0
and backported no further than the `0.19` branch. This tree cannot reach either:
gtk3-rs stopped at 0.18, and `gtk`, `gdk`, `webkit2gtk`, `tao`, `muda` and `wry`
under Tauri all pin glib 0.18. The advisory is therefore unfixable by version
bump, which is what Dependabot reports.

No crate in our dependency graph constructs a `VariantStrIter` today
(`Variant::array_iter_str` is called only by glib's own tests), so this is a
latent rather than a live crash — but the unsound code would otherwise still be
compiled into every binary we ship.

### Provenance

Extracted from the crates.io tarball for glib 0.18.5:

    sha256  233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5

which is the checksum `Cargo.lock` recorded before the patch was applied. Two
hunks differ from that tarball:

1. `src/variant_iter.rs` — the upstream fix, `let mut p` and `&mut p`.
2. `Cargo.toml` — a `[lints.rust]` table. Cargo applies `--cap-lints allow` to
   registry dependencies but not to path ones, so without it every build prints
   the lints newer rustc raises on this 2023 snapshot.

To verify, unpack the tarball and diff:

    cargo fetch --manifest-path src-tauri/Cargo.toml
    tar xzf "$(ls ~/.cargo/registry/cache/*/glib-0.18.5.crate)" -C "$(mktemp -d)"
    diff -ru <extracted>/glib-0.18.5 src-tauri/third_party/glib-0.18.5

### Cost: glib is no longer audited

`Cargo.lock` records the patched crate without a registry source, and
`cargo audit` skips packages that have none. It therefore no longer reports
RUSTSEC-2024-0429 — which is the point — but it will equally not report any
*future* glib advisory. Little is lost in practice, since gtk3-rs is frozen and
a later advisory would be just as unfixable by version bump, but the detection
is gone: check <https://rustsec.org/packages/glib.html> by hand when reviewing
this file.

### Removing this

Drop the directory, the `[patch.crates-io]` and `[workspace]` tables in
`../Cargo.toml`, and re-run `cargo update -p glib` once the WebKitGTK stack
under Tauri moves to a glib 0.20 or later — most likely when Tauri's Linux
backend moves off gtk3.
