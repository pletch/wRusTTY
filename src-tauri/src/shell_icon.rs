//! A detected shell's own icon, read from its executable on this machine.
//!
//! This is how the tab strip shows the real PowerShell and Command Prompt
//! icons without the app distributing either. Microsoft's trademark terms
//! prohibit using its logos without permission — which is why Simple Icons
//! removed every Microsoft brand in 2024 (simple-icons#10019) — so bundling a
//! copy is not an option. Reading the icon that `pwsh.exe` already carries, on
//! the machine it is installed on, redistributes nothing: the pixels come from
//! the user's own installation, exactly as Explorer and the taskbar show them.
//! It is also the only way to be sure the colours match what Windows shows.
//!
//! # Why this takes a shell id rather than a path
//!
//! The webview asks for `pwsh`, and the path is resolved here through
//! detection. Accepting a path would let whatever runs in the webview name any
//! file on any machine, and reading an icon from a UNC path makes Windows open
//! an SMB connection to that host — which authenticates as the user. There is
//! no reason for that door to exist when the only paths worth reading are the
//! ones detection already found.

use base64::Engine as _;

use crate::local_shells::{detect, SystemMachine};

/// Pixels per side. Displayed at 12–16 CSS px, so 32 stays sharp up to a 2x
/// display without asking the shell for something much larger than it ships.
const ICON_PX: u32 = 32;

/// A `data:image/png` URL for a detected shell's icon, or `None` when the
/// shell is unknown, has no icon, or this is not Windows.
///
/// `None` is an ordinary answer — the frontend falls back to a drawn glyph —
/// so nothing here is an error worth reporting to the user.
#[tauri::command]
pub async fn local_shell_icon(shell_id: String) -> Option<String> {
    // Registry reads, a file read and GDI calls: all blocking, none of them
    // anything the async runtime's worker threads should be sitting in.
    tauri::async_runtime::spawn_blocking(move || {
        let shell = detect(&SystemMachine)
            .into_iter()
            .find(|s| s.id == shell_id)?;
        let rgba = read_icon_rgba(&shell.command, ICON_PX)?;
        let png = encode_png(&rgba, ICON_PX)?;
        Some(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(png)
        ))
    })
    .await
    .ok()
    .flatten()
}

/// Straight (non-premultiplied) RGBA, `size * size * 4` bytes, top row first.
fn encode_png(rgba: &[u8], size: u32) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, size, size);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(rgba).ok()?;
    }
    Some(out)
}

/// GDI's 32-bit DIB is BGRA; the PNG wants RGBA.
///
/// `mask` covers icons that predate alpha channels: every alpha byte in the
/// colour bitmap is then zero, and transparency lives in a separate AND mask
/// instead, where a white pixel is see-through and a black one is opaque.
/// Without this fallback such an icon would encode as fully transparent and
/// simply not appear.
// Called only by the Windows extractor, but kept ungated so its tests run on
// every platform.
#[cfg_attr(not(windows), allow(dead_code))]
fn bgra_to_rgba(bgra: &[u8], mask: Option<&[u8]>) -> Vec<u8> {
    let has_alpha = bgra.chunks_exact(4).any(|px| px[3] != 0);
    let mut rgba = Vec::with_capacity(bgra.len());
    for (i, px) in bgra.chunks_exact(4).enumerate() {
        let alpha = if has_alpha {
            px[3]
        } else {
            match mask {
                Some(mask) => {
                    let m = &mask[i * 4..i * 4 + 3];
                    if m.iter().all(|&c| c == 0) {
                        255
                    } else {
                        0
                    }
                }
                None => 255,
            }
        };
        rgba.extend_from_slice(&[px[2], px[1], px[0], alpha]);
    }
    rgba
}

#[cfg(windows)]
fn read_icon_rgba(path: &str, size: u32) -> Option<Vec<u8>> {
    use std::ffi::c_void;
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Gdi::{
        DeleteObject, GetDC, GetDIBits, ReleaseDC, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        DIB_RGB_COLORS, HBITMAP, HDC,
    };
    use windows::Win32::UI::Shell::SHDefExtractIconW;
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

    /// Everything GDI hands back here has to be released on every path out,
    /// including the early returns — so each is owned by something that
    /// releases it on drop, rather than by a cleanup block that one branch
    /// forgets.
    struct Icon(HICON);
    impl Drop for Icon {
        fn drop(&mut self) {
            unsafe {
                let _ = DestroyIcon(self.0);
            }
        }
    }
    struct Bitmap(HBITMAP);
    impl Drop for Bitmap {
        fn drop(&mut self) {
            if !self.0.is_invalid() {
                unsafe {
                    let _ = DeleteObject(self.0.into());
                }
            }
        }
    }
    struct ScreenDc(HDC);
    impl Drop for ScreenDc {
        fn drop(&mut self) {
            unsafe {
                ReleaseDC(None, self.0);
            }
        }
    }

    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let mut large = HICON::default();
    // The size argument packs the large icon's size into the low word; the
    // small one is not asked for. SHDefExtractIcon scales to the size given,
    // which is the point of using it over ExtractIconEx's fixed 32px.
    unsafe {
        SHDefExtractIconW(PCWSTR(wide.as_ptr()), 0, 0, Some(&mut large), None, size)
            // An HRESULT: `.ok()` makes it a Result, the second an Option.
            .ok()
            .ok()?;
    }
    if large.is_invalid() {
        return None;
    }
    let icon = Icon(large);

    let mut info = ICONINFO::default();
    unsafe { GetIconInfo(icon.0, &mut info).ok()? };
    let color = Bitmap(info.hbmColor);
    let mask = Bitmap(info.hbmMask);
    // A monochrome icon has no colour bitmap at all. None of the shells this
    // is asked about ship one, and a fallback glyph is the right answer if one
    // ever does.
    if color.0.is_invalid() {
        return None;
    }

    let dc = ScreenDc(unsafe { GetDC(None) });
    let read = |bitmap: HBITMAP| -> Option<Vec<u8>> {
        let mut header = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: size as i32,
                // Negative for top-down rows, which is the order the PNG wants.
                biHeight: -(size as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut buf = vec![0u8; (size * size * 4) as usize];
        let lines = unsafe {
            GetDIBits(
                dc.0,
                bitmap,
                0,
                size,
                Some(buf.as_mut_ptr() as *mut c_void),
                &mut header,
                DIB_RGB_COLORS,
            )
        };
        (lines == size as i32).then_some(buf)
    };

    let bgra = read(color.0)?;
    let mask_bits = if mask.0.is_invalid() {
        None
    } else {
        read(mask.0)
    };
    Some(bgra_to_rgba(&bgra, mask_bits.as_deref()))
}

#[cfg(not(windows))]
fn read_icon_rgba(_path: &str, _size: u32) -> Option<Vec<u8>> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channels_are_swapped_from_bgra() {
        let bgra = [10, 20, 30, 255];
        assert_eq!(bgra_to_rgba(&bgra, None), vec![30, 20, 10, 255]);
    }

    #[test]
    fn a_real_alpha_channel_is_kept() {
        let bgra = [0, 0, 0, 128, 0, 0, 0, 0];
        let rgba = bgra_to_rgba(&bgra, None);
        assert_eq!(rgba[3], 128);
        assert_eq!(rgba[7], 0);
    }

    /// An icon from before alpha channels carries its transparency in the AND
    /// mask instead. Ignoring that encodes it as invisible.
    #[test]
    fn an_icon_without_alpha_takes_transparency_from_its_mask() {
        let bgra = [9, 9, 9, 0, 9, 9, 9, 0];
        // First pixel black in the mask (opaque), second white (see-through).
        let mask = [0, 0, 0, 0, 255, 255, 255, 0];
        let rgba = bgra_to_rgba(&bgra, Some(&mask));
        assert_eq!(rgba[3], 255);
        assert_eq!(rgba[7], 0);
    }

    #[test]
    fn encodes_a_valid_png() {
        let rgba = vec![255u8; 2 * 2 * 4];
        let png = encode_png(&rgba, 2).expect("encodes");
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    }

    /// The whole path against the real machine: `cmd.exe` exists on every
    /// Windows install, so a missing icon here means extraction is broken
    /// rather than that the shell is absent.
    #[cfg(windows)]
    #[test]
    fn reads_the_real_command_prompt_icon() {
        let cmd = detect(&SystemMachine)
            .into_iter()
            .find(|s| s.id == "cmd")
            .expect("cmd.exe is always detected");
        let rgba = read_icon_rgba(&cmd.command, ICON_PX).expect("cmd.exe has an icon");
        assert_eq!(rgba.len(), (ICON_PX * ICON_PX * 4) as usize);
        // An icon that decoded as entirely transparent would pass every other
        // check and draw nothing.
        assert!(
            rgba.chunks_exact(4).any(|px| px[3] > 0),
            "the icon decoded as fully transparent"
        );
    }
}
