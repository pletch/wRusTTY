//! Enumerating the fonts installed on this machine.
//!
//! The generalizable point, and the reason this lives in Rust rather than in
//! the webview: the webview constrains where glyphs are *rasterized*, not what
//! the application is allowed to *know* about fonts. Local Font Access is
//! Chromium-only and permission-gated, and asking for a permission prompt to
//! populate a settings dropdown is a poor trade. Any font question that is
//! metadata rather than pixels can cross the IPC boundary cheaply and be
//! answered natively — so it is.
//!
//! DirectWrite rather than a crate: it is already in the process, it is the
//! same system font collection the webview itself resolves against, and it
//! answers the monospace question directly via `IDWriteFont1::IsMonospacedFont`
//! instead of leaving us to infer it from PANOSE bytes.

use serde::Serialize;

/// One installed family, and whether it is fixed-pitch.
///
/// The flag is carried rather than filtered on here because the caller wants
/// both answers: the picker lists the monospaced families, and a *warning*
/// needs to know that the family someone typed or imported is not one. The
/// engine measures a single glyph and assumes the rest match, so a proportional
/// face renders with visibly wrong column alignment — a failure that looks like
/// a rendering bug rather than like a font choice.
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
        // Every call below is a read against the system font collection; none
        // of it hands out an interface we keep past this function.
        unsafe {
            let factory: IDWriteFactory = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED)
                .map_err(|e| format!("DWriteCreateFactory failed: {e}"))?;

            let mut collection: Option<IDWriteFontCollection> = None;
            // `false`: we want whatever the collection already holds, not a
            // rescan of the font directories. A settings dialog opening is not
            // a reason to make the font cache go to disk.
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

                // A family carries its name in every locale it was authored
                // for. en-us if it has one, otherwise index 0 — which is what
                // DirectWrite's own samples do, and is the name the webview
                // will match against when this string is put in a CSS stack.
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
                // GetString writes a terminating null, so the buffer is one
                // longer than the length it just reported.
                let mut buf = vec![0u16; len as usize + 1];
                if names.GetString(index, &mut buf).is_err() {
                    continue;
                }
                let name = String::from_utf16_lossy(&buf[..len as usize]);
                if name.is_empty() {
                    continue;
                }

                // Asked of the regular face: a family is monospaced or not as a
                // whole, and the regular weight is the one that always exists.
                let monospace = family
                    .GetFirstMatchingFont(
                        DWRITE_FONT_WEIGHT_NORMAL,
                        DWRITE_FONT_STRETCH_NORMAL,
                        DWRITE_FONT_STYLE_NORMAL,
                    )
                    .ok()
                    .and_then(|font| font.cast::<IDWriteFont1>().ok())
                    // IDWriteFont1 is DirectWrite 1.1, i.e. Windows 7 with the
                    // platform update. Older than that answers "not monospaced"
                    // rather than failing the whole enumeration.
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

    /// No enumeration off Windows. The command still exists so the settings
    /// dialog has one code path: an empty list means "offer the curated stacks
    /// only", which is what it did before this existed.
    pub fn list() -> Result<Vec<FontFamily>, String> {
        Ok(Vec::new())
    }
}

#[tauri::command]
pub fn list_fonts() -> Result<Vec<FontFamily>, String> {
    imp::list()
}
