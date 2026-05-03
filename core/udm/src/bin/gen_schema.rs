//! Generate `proto/udm.schema.json` from the Rust UDM types.
//!
//! Usage:
//!   cargo run --bin gen_schema                         # writes ../../proto/udm.schema.json
//!   cargo run --bin gen_schema -- /path/to/output.json # custom output path

use std::env;
use std::path::PathBuf;
use std::process::ExitCode;

use schemars::schema_for;
use udm::Document;

fn main() -> ExitCode {
    let out = env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(default_output_path);

    let schema = schema_for!(Document);
    let json = match serde_json::to_string_pretty(&schema) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("error: failed to serialize schema: {e}");
            return ExitCode::from(2);
        }
    };

    if let Some(parent) = out.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            eprintln!("error: failed to create parent dir {}: {e}", parent.display());
            return ExitCode::from(2);
        }
    }

    if let Err(e) = std::fs::write(&out, &json) {
        eprintln!("error: failed to write {}: {e}", out.display());
        return ExitCode::from(2);
    }

    println!("Wrote {} ({} bytes)", out.display(), json.len());
    ExitCode::SUCCESS
}

fn default_output_path() -> PathBuf {
    // CARGO_MANIFEST_DIR points to core/udm/.
    // Schema lives at AllDocs/proto/udm.schema.json => ../../proto/udm.schema.json
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("proto")
        .join("udm.schema.json")
}
