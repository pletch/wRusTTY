//! Enumerating installed fonts. In Rust because Local Font Access is
//! Chromium-only and permission-gated; font metadata crosses IPC cheaply.
//! DirectWrite, since it's already loaded, is the collection the webview
//! resolves against, and answers monospace directly
//! (`IDWriteFont1::IsMonospacedFont`).

use serde::Serialize;

/// One installed family and whether it's fixed-pitch. Not filtered here: the
/// picker lists monospaced families, and a warning needs to know when a typed
/// or imported family isn't one (the engine measures one glyph, so a
/// proportional face misaligns columns).
#[derive(Serialize, Clone, Debug)]
pub struct FontFamily {
    pub name: String,
    pub monospace: bool,
}

#[cfg(target_os = "windows")]
mod imp {
    use super::FontFamily;
    use windows::core::Interface;
    use windows::Win32::Graphics::DirectWrite::{
        DWriteCreateFactory, IDWriteFactory, IDWriteFont1, IDWriteFontCollection,
        DWRITE_FACTORY_TYPE_SHARED, DWRITE_FONT_STRETCH_NORMAL, DWRITE_FONT_STYLE_NORMAL,
        DWRITE_FONT_WEIGHT_NORMAL,
    };

    pub fn list() -> Result<Vec<FontFamily>, String> {
        // Reads against the system collection; no interface outlives this function.
        unsafe {
            let factory: IDWriteFactory = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED)
                .map_err(|e| format!("DWriteCreateFactory failed: {e}"))?;

            let mut collection: Option<IDWriteFontCollection> = None;
            // `false`: use the collection as held, without rescanning font directories.
            factory
                .GetSystemFontCollection(&mut collection, false)
                .map_err(|e| format!("GetSystemFontCollection failed: {e}"))?;
            let collection = collection.ok_or_else(|| "no system font collection".to_string())?;

            let count = collection.GetFontFamilyCount();
            let mut out = Vec::with_capacity(count as usize);
            for i in 0..count {
                let Ok(family) = collection.GetFontFamily(i) else {
                    continue;
                };
                let Ok(names) = family.GetFamilyNames() else {
                    continue;
                };

                // en-us if present, otherwise index 0, as DirectWrite's samples do and the
                // name the webview matches in a CSS stack.
                let mut index = 0u32;
                let mut exists = windows::core::BOOL(0);
                let locale: Vec<u16> = "en-us\0".encode_utf16().collect();
                let _ = names.FindLocaleName(
                    windows::core::PCWSTR(locale.as_ptr()),
                    &mut index,
                    &mut exists,
                );
                if !exists.as_bool() {
                    index = 0;
                }

                let Ok(len) = names.GetStringLength(index) else {
                    continue;
                };
                // GetString writes a terminating null, so one extra slot.
                let mut buf = vec![0u16; len as usize + 1];
                if names.GetString(index, &mut buf).is_err() {
                    continue;
                }
                let name = String::from_utf16_lossy(&buf[..len as usize]);
                if name.is_empty() {
                    continue;
                }

                // Asked of the regular face, which always exists.
                let monospace = family
                    .GetFirstMatchingFont(
                        DWRITE_FONT_WEIGHT_NORMAL,
                        DWRITE_FONT_STRETCH_NORMAL,
                        DWRITE_FONT_STYLE_NORMAL,
                    )
                    .ok()
                    .and_then(|font| font.cast::<IDWriteFont1>().ok())
                    // IDWriteFont1 is DirectWrite 1.1; older systems answer "not monospaced"
                    // rather than failing.
                    .map(|font1| font1.IsMonospacedFont().as_bool())
                    .unwrap_or(false);

                out.push(FontFamily { name, monospace });
            }

            out.sort_by_key(|f| f.name.to_lowercase());
            out.dedup_by(|a, b| a.name == b.name);
            Ok(out)
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::FontFamily;

    /// No enumeration off Windows; an empty list means "curated stacks only".
    pub fn list() -> Result<Vec<FontFamily>, String> {
        Ok(Vec::new())
    }
}

#[tauri::command]
pub fn list_fonts() -> Result<Vec<FontFamily>, String> {
    imp::list()
}
