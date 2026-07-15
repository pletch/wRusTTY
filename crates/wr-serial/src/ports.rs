use serde::Serialize;

use crate::error::SerialError;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortInfo {
    pub name: String,
    /// USB manufacturer/product strings joined, when the OS reports them —
    /// what makes "COM3" show up as "COM3 (Arduino Uno)" in the picker.
    pub friendly_name: Option<String>,
}

pub fn list_ports() -> Result<Vec<PortInfo>, SerialError> {
    let ports = tokio_serial::available_ports()
        .map_err(|e| SerialError::Io(std::io::Error::other(e.to_string())))?;

    Ok(ports
        .into_iter()
        .map(|p| {
            let friendly_name = match &p.port_type {
                tokio_serial::SerialPortType::UsbPort(usb) => {
                    let parts: Vec<&str> = [usb.manufacturer.as_deref(), usb.product.as_deref()]
                        .into_iter()
                        .flatten()
                        .collect();
                    if parts.is_empty() {
                        None
                    } else {
                        Some(parts.join(" "))
                    }
                }
                _ => None,
            };
            PortInfo {
                name: p.port_name,
                friendly_name,
            }
        })
        .collect())
}
