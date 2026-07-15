use std::sync::Arc;

use async_trait::async_trait;
use russh::keys::PublicKey;
use tokio::sync::Mutex;

use crate::error::SshError;
use crate::forward::{self, RemoteForwardRegistry};
use crate::known_hosts::{fingerprint, HostKeyStatus, KnownHostsStore};

/// What the UI needs to render a host-key accept/reject prompt.
#[derive(Debug, Clone)]
pub struct HostKeyPrompt {
    pub host: String,
    pub port: u16,
    pub fingerprint: String,
    pub status: HostKeyStatus,
}

/// Decides whether an unknown or changed host key should be trusted.
/// Implemented by the caller (in Phase 1, `src-tauri`'s command layer,
/// backed by a real accept/reject dialog); a `false`/reject answer aborts
/// the connection, never falls back to trusting it anyway.
#[async_trait]
pub trait HostKeyVerifier: Send + Sync {
    async fn verify(&self, prompt: HostKeyPrompt) -> bool;
}

/// A verifier that rejects everything. Useful as a safe default and in
/// tests that shouldn't ever need to prompt.
pub struct RejectAll;

#[async_trait]
impl HostKeyVerifier for RejectAll {
    async fn verify(&self, _prompt: HostKeyPrompt) -> bool {
        false
    }
}

pub(crate) struct ClientHandler {
    host: String,
    port: u16,
    known_hosts: Arc<Mutex<KnownHostsStore>>,
    verifier: Arc<dyn HostKeyVerifier>,
    remote_forwards: RemoteForwardRegistry,
    /// Fired the instant we're about to block on a human accepting or
    /// rejecting an unknown host key, so the caller's connect-phase timeout
    /// (meant to bound pure network stalls) can stop counting down — a
    /// person reading a fingerprint routinely takes longer than any
    /// reasonable network timeout.
    verify_started: Arc<tokio::sync::Notify>,
}

impl ClientHandler {
    pub(crate) fn new(
        host: String,
        port: u16,
        known_hosts: Arc<Mutex<KnownHostsStore>>,
        verifier: Arc<dyn HostKeyVerifier>,
        remote_forwards: RemoteForwardRegistry,
        verify_started: Arc<tokio::sync::Notify>,
    ) -> Self {
        Self {
            host,
            port,
            known_hosts,
            verifier,
            remote_forwards,
            verify_started,
        }
    }
}

impl russh::client::Handler for ClientHandler {
    type Error = SshError;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let status = {
            let store = self.known_hosts.lock().await;
            store.check(&self.host, self.port, server_public_key)
        };

        if status == HostKeyStatus::Trusted {
            return Ok(true);
        }

        let prompt = HostKeyPrompt {
            host: self.host.clone(),
            port: self.port,
            fingerprint: fingerprint(server_public_key),
            status,
        };

        self.verify_started.notify_one();

        // Never fall back to trusting on a `false` answer or on any error
        // from the store write — an unaccepted or unrecorded key must abort
        // the connection, not proceed silently.
        if !self.verifier.verify(prompt).await {
            return Err(SshError::HostKeyRejected {
                host: self.host.clone(),
                port: self.port,
            });
        }

        let mut store = self.known_hosts.lock().await;
        store.learn(&self.host, self.port, server_public_key)?;
        Ok(true)
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<russh::client::Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        let target = self
            .remote_forwards
            .lock()
            .await
            .get(&(connected_address.to_string(), connected_port as u16))
            .cloned();

        let Some((target_host, target_port)) = target else {
            reply
                .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
                .await;
            return Ok(());
        };

        reply.accept().await;
        tokio::spawn(async move {
            match tokio::net::TcpStream::connect((target_host.as_str(), target_port)).await {
                Ok(stream) => forward::pipe(stream, channel).await,
                Err(e) => tracing::warn!(error = %e, "failed to connect local forward target"),
            }
        });
        Ok(())
    }
}
