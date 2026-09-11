// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Before anything else — before Tauri, and above all before the
    // single-instance plugin, which would hand an elevated host's arguments to
    // the running window and exit. See `elevation::elevated_entry_point`.
    if let Some(code) = wrustty_lib::elevated_entry_point() {
        std::process::exit(code);
    }
    wrustty_lib::run();
}
