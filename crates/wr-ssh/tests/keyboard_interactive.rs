//! End-to-end keyboard-interactive auth against a real SSH server.
//!
//! The one method here whose behaviour is *not* knowable at connect time: the
//! server decides how many rounds there are, what each asks, and which fields
//! are secret. None of that can be covered by unit tests on our side of the
//! wire, so this stands up an actual `russh` server, connects a real
//! `SshConnector` to it over a loopback socket, and drives the exchange.
//!
//! Cheap enough to be an ordinary `cargo test` — no container, no sshd, no
//! network beyond `127.0.0.1` — which is what makes it worth having for the
//! cases that are otherwise only reachable by finding a Duo-protected bastion
//! and typing at it.

use std::borrow::Cow;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use russh::server::{
    Auth, ChannelOpenHandle, Handler as ServerHandler, Msg, Response, Session as ServerSession,
};
use russh::{Channel, ChannelId};
use tokio::sync::mpsc;
use wr_core::{ConnectionEvent, Connector};
use wr_ssh::{
    AuthMethod, AuthPrompt, AuthPrompter, HostKeyPrompt, HostKeyVerifier, SshConfig, SshConnector,
    SshError,
};
use zeroize::Zeroizing;

// ---------------------------------------------------------------- the server

/// One round of questions the test server will ask.
#[derive(Clone)]
struct Round {
    name: &'static str,
    instructions: &'static str,
    /// `(prompt, echo)`, exactly as the protocol carries it.
    prompts: Vec<(&'static str, bool)>,
}

impl Round {
    fn asking(prompts: Vec<(&'static str, bool)>) -> Self {
        Self {
            name: "",
            instructions: "",
            prompts,
        }
    }
}

struct TestServer {
    rounds: Vec<Round>,
    /// Next round to send. Advances once per client request.
    next: usize,
    /// Answers that authenticate. Compared against what actually arrived.
    accepts: Vec<Vec<String>>,
    /// Every set of answers the client sent, in order, for assertions.
    received: Arc<Mutex<Vec<Vec<String>>>>,
}

impl ServerHandler for TestServer {
    type Error = russh::Error;

    async fn auth_keyboard_interactive(
        &mut self,
        _user: &str,
        _submethods: &str,
        response: Option<Response<'_>>,
    ) -> Result<Auth, Self::Error> {
        // `None` is the opening request; anything else is answers to the round
        // sent last time round.
        if let Some(response) = response {
            let answers = response
                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                .collect();
            self.received.lock().unwrap().push(answers);
        }

        if let Some(round) = self.rounds.get(self.next).cloned() {
            self.next += 1;
            return Ok(Auth::Partial {
                name: round.name.into(),
                instructions: round.instructions.into(),
                prompts: round
                    .prompts
                    .into_iter()
                    .map(|(prompt, echo)| (Cow::Borrowed(prompt), echo))
                    .collect::<Vec<_>>()
                    .into(),
            });
        }

        if *self.received.lock().unwrap() == self.accepts {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::reject())
        }
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        reply: ChannelOpenHandle,
        _session: &mut ServerSession,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut ServerSession,
    ) -> Result<(), Self::Error> {
        // The client asks for the shell with `want_reply: true` and will hang
        // without this.
        session.channel_success(channel)?;
        Ok(())
    }
}

/// Starts the test server on an ephemeral loopback port, returning it.
///
/// One connection is served and then the task ends — every test here connects
/// exactly once, and a listener that outlives the test is a leak that only
/// shows up as a flake somewhere else.
async fn serve(
    rounds: Vec<Round>,
    accepts: Vec<Vec<String>>,
) -> (u16, Arc<Mutex<Vec<Vec<String>>>>) {
    let received = Arc::new(Mutex::new(Vec::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    // Reuses the ed25519 key already sitting in `tests/fixtures` for the PPK
    // tests rather than generating one: a host key is a host key, and the
    // client here trusts whatever it is handed anyway.
    let config = Arc::new(russh::server::Config {
        keys: vec![
            wr_ssh::parse_private_key(include_str!("fixtures/id_ed25519.ppk"), None).unwrap(),
        ],
        ..Default::default()
    });

    let handler_received = received.clone();
    tokio::spawn(async move {
        let Ok((stream, _)) = listener.accept().await else {
            return;
        };
        let handler = TestServer {
            rounds,
            next: 0,
            accepts,
            received: handler_received,
        };
        if let Ok(session) = russh::server::run_stream(config, stream, handler).await {
            let _ = session.await;
        }
    });

    (port, received)
}

/// A server that will not do keyboard-interactive at all, but will take a
/// password — the default `sshd_config` Debian and Ubuntu ship, where
/// `KbdInteractiveAuthentication` is `no` and `PasswordAuthentication` is
/// `yes`. Extremely common, and the shape that made "Prompt me" fail with
/// "authentication failed" before a dialog was ever shown.
struct PasswordOnlyServer {
    accepts: &'static str,
    /// Set when the client asked for keyboard-interactive, so a test can tell
    /// "never tried it" from "tried it and fell back".
    tried_interactive: Arc<Mutex<bool>>,
}

impl ServerHandler for PasswordOnlyServer {
    type Error = russh::Error;

    async fn auth_keyboard_interactive(
        &mut self,
        _user: &str,
        _submethods: &str,
        _response: Option<Response<'_>>,
    ) -> Result<Auth, Self::Error> {
        *self.tried_interactive.lock().unwrap() = true;
        Ok(Auth::reject())
    }

    async fn auth_password(&mut self, _user: &str, password: &str) -> Result<Auth, Self::Error> {
        if password == self.accepts {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::reject())
        }
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        reply: ChannelOpenHandle,
        _session: &mut ServerSession,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut ServerSession,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }
}

/// Same as `serve`, for the password-only server above. `methods` is what the
/// server advertises as still available after a rejection — the list the
/// client has to read to know a fallback is even possible.
async fn serve_password_only(
    accepts: &'static str,
    methods: &[russh::MethodKind],
) -> (u16, Arc<Mutex<bool>>) {
    let tried_interactive = Arc::new(Mutex::new(false));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let config = Arc::new(russh::server::Config {
        keys: vec![
            wr_ssh::parse_private_key(include_str!("fixtures/id_ed25519.ppk"), None).unwrap(),
        ],
        methods: methods.into(),
        ..Default::default()
    });

    let flag = tried_interactive.clone();
    tokio::spawn(async move {
        let Ok((stream, _)) = listener.accept().await else {
            return;
        };
        let handler = PasswordOnlyServer {
            accepts,
            tried_interactive: flag,
        };
        if let Ok(session) = russh::server::run_stream(config, stream, handler).await {
            let _ = session.await;
        }
    });

    (port, tried_interactive)
}

// ---------------------------------------------------------------- the client

/// Trusts any host key. The host-key path has its own tests; here it would
/// only be a way for these to fail for an unrelated reason.
struct AcceptAnyHostKey;

#[async_trait]
impl HostKeyVerifier for AcceptAnyHostKey {
    async fn verify(&self, _prompt: HostKeyPrompt) -> bool {
        true
    }
}

/// Answers each round from a script, recording what it was asked.
struct ScriptedPrompter {
    /// One entry per round; `None` cancels. Popped from the front.
    answers: Mutex<std::collections::VecDeque<Option<Vec<String>>>>,
    seen: Arc<Mutex<Vec<AuthPrompt>>>,
}

#[async_trait]
impl AuthPrompter for ScriptedPrompter {
    async fn prompt(&self, prompt: AuthPrompt) -> Option<Zeroizing<Vec<String>>> {
        self.seen.lock().unwrap().push(prompt);
        self.answers
            .lock()
            .unwrap()
            .pop_front()
            .flatten()
            .map(Zeroizing::new)
    }
}

/// Connects to `port` with keyboard-interactive auth, answering from `script`.
/// Returns the connection result and every prompt the user was shown.
async fn connect_with(
    port: u16,
    script: Vec<Option<Vec<String>>>,
) -> (Result<(), SshError>, Vec<AuthPrompt>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let prompter = Arc::new(ScriptedPrompter {
        answers: Mutex::new(script.into()),
        seen: seen.clone(),
    });

    let dir = tempfile::tempdir().unwrap();
    let connector = SshConnector::new(
        SshConfig {
            host: "127.0.0.1".into(),
            port,
            username: "tester".into(),
            auth: AuthMethod::KeyboardInteractive,
            ..Default::default()
        },
        dir.path().join("known_hosts"),
        Arc::new(AcceptAnyHostKey),
        prompter,
        80,
        24,
    )
    .unwrap();

    let (tx, mut rx) = mpsc::channel::<ConnectionEvent>(64);
    // Drained so a full channel can't be what stalls the handshake.
    tokio::spawn(async move { while rx.recv().await.is_some() {} });

    let result = connector.connect(tx).await.map(|_| ());
    let prompts = std::mem::take(&mut *seen.lock().unwrap());
    (result, prompts)
}

// ----------------------------------------------------------------- the tests

/// The plain case, and the one the whole feature exists for: a username with
/// no stored password, answered at connect time.
#[tokio::test]
async fn a_single_round_password_authenticates() {
    let (port, received) = serve(
        vec![Round::asking(vec![("Password: ", false)])],
        vec![vec!["hunter2".into()]],
    )
    .await;

    let (result, prompts) = connect_with(port, vec![Some(vec!["hunter2".into()])]).await;

    assert!(result.is_ok(), "expected a connection, got {result:?}");
    assert_eq!(prompts.len(), 1);
    assert_eq!(prompts[0].fields[0].prompt, "Password: ");
    // The server said this one is a secret; that has to survive the trip or
    // the dialog renders a password in plain text.
    assert!(!prompts[0].fields[0].echo);
    assert_eq!(*received.lock().unwrap(), vec![vec!["hunter2".to_string()]]);
}

/// The 2FA shape: two rounds, asked one after the other, each with its own
/// dialog. This is what the old stub could never have done.
#[tokio::test]
async fn a_two_round_exchange_asks_each_round_in_turn() {
    let (port, received) = serve(
        vec![
            Round::asking(vec![("Password: ", false)]),
            Round::asking(vec![("Verification code: ", true)]),
        ],
        vec![vec!["hunter2".into()], vec!["123456".into()]],
    )
    .await;

    let (result, prompts) = connect_with(
        port,
        vec![Some(vec!["hunter2".into()]), Some(vec!["123456".into()])],
    )
    .await;

    assert!(result.is_ok(), "expected a connection, got {result:?}");
    assert_eq!(prompts.len(), 2);
    assert_eq!(prompts[0].fields[0].prompt, "Password: ");
    assert_eq!(prompts[1].fields[0].prompt, "Verification code: ");
    // Per-field, not per-exchange: a one-time code is routinely echoed while
    // the password before it is not.
    assert!(!prompts[0].fields[0].echo);
    assert!(prompts[1].fields[0].echo);
    assert_eq!(
        *received.lock().unwrap(),
        vec![vec!["hunter2".to_string()], vec!["123456".to_string()]]
    );
}

/// Several fields in one round — the other multi-answer shape, and the one
/// where getting the order wrong silently sends the password as the code.
#[tokio::test]
async fn one_round_can_ask_several_things_at_once() {
    let (port, received) = serve(
        vec![Round::asking(vec![
            ("Password: ", false),
            ("Token: ", false),
        ])],
        vec![vec!["hunter2".into(), "999111".into()]],
    )
    .await;

    let (result, prompts) =
        connect_with(port, vec![Some(vec!["hunter2".into(), "999111".into()])]).await;

    assert!(result.is_ok(), "expected a connection, got {result:?}");
    assert_eq!(prompts[0].fields.len(), 2);
    assert_eq!(
        *received.lock().unwrap(),
        vec![vec!["hunter2".to_string(), "999111".to_string()]]
    );
}

/// A round with no fields is the server displaying something, not asking. It
/// still needs an (empty) answer to move the exchange along, but putting an
/// empty dialog on screen would train people to click through this whole class
/// of prompt unread.
#[tokio::test]
async fn a_round_with_nothing_to_fill_in_never_reaches_the_user() {
    let (port, received) = serve(
        vec![
            Round {
                name: "Notice",
                instructions: "Your password expires in 3 days.",
                prompts: vec![],
            },
            Round::asking(vec![("Password: ", false)]),
        ],
        vec![vec![], vec!["hunter2".into()]],
    )
    .await;

    // Only one answer scripted, because only one prompt should ever be shown.
    let (result, prompts) = connect_with(port, vec![Some(vec!["hunter2".into()])]).await;

    assert!(result.is_ok(), "expected a connection, got {result:?}");
    assert_eq!(prompts.len(), 1, "the empty round should not have prompted");
    assert_eq!(prompts[0].fields[0].prompt, "Password: ");
    assert_eq!(
        *received.lock().unwrap(),
        vec![vec![], vec!["hunter2".to_string()]]
    );
}

/// The server's own wording and heading are relayed rather than replaced —
/// they are the only thing distinguishing one challenge from another.
#[tokio::test]
async fn the_servers_name_and_instructions_reach_the_user() {
    let (port, _) = serve(
        vec![Round {
            name: "Duo two-factor login",
            instructions: "Enter a passcode or select one of the following options:",
            prompts: vec![("Passcode or option (1-3): ", false)],
        }],
        vec![vec!["1".into()]],
    )
    .await;

    let (result, prompts) = connect_with(port, vec![Some(vec!["1".into()])]).await;

    assert!(result.is_ok(), "expected a connection, got {result:?}");
    assert_eq!(prompts[0].name, "Duo two-factor login");
    assert!(prompts[0].instructions.contains("Enter a passcode"));
}

/// Cancelling abandons the connection instead of submitting blanks. Blanks are
/// a *wrong* answer, and would burn one of the server's limited attempts on
/// the user's behalf.
#[tokio::test]
async fn cancelling_a_prompt_abandons_the_connection() {
    let (port, received) = serve(
        vec![Round::asking(vec![("Password: ", false)])],
        vec![vec!["hunter2".into()]],
    )
    .await;

    let (result, prompts) = connect_with(port, vec![None]).await;

    assert!(
        matches!(result, Err(SshError::AuthCancelled)),
        "expected AuthCancelled, got {result:?}"
    );
    assert_eq!(prompts.len(), 1);
    // Nothing was sent — not even an empty answer.
    assert!(received.lock().unwrap().is_empty());
}

/// A wrong answer is a plain auth failure, distinct from a cancel.
#[tokio::test]
async fn a_wrong_answer_fails_authentication() {
    let (port, _) = serve(
        vec![Round::asking(vec![("Password: ", false)])],
        vec![vec!["hunter2".into()]],
    )
    .await;

    let (result, _) = connect_with(port, vec![Some(vec!["wrong".into()])]).await;

    assert!(
        matches!(result, Err(SshError::AuthFailed)),
        "expected AuthFailed, got {result:?}"
    );
}

/// The reported bug: "Prompt me" against a server with
/// `KbdInteractiveAuthentication no` failed with "authentication failed"
/// before a dialog was ever shown. The server refuses the method, names
/// `password` as what it will take instead, and that answer used to be thrown
/// away.
#[tokio::test]
async fn a_server_that_refuses_the_method_falls_back_to_asking_for_a_password() {
    let (port, tried) = serve_password_only("hunter2", &[russh::MethodKind::Password]).await;

    let (result, prompts) = connect_with(port, vec![Some(vec!["hunter2".into()])]).await;

    assert!(result.is_ok(), "expected a connection, got {result:?}");
    assert!(
        *tried.lock().unwrap(),
        "keyboard-interactive should still be tried first"
    );
    // The point of the fix: the user is asked, rather than told no.
    assert_eq!(prompts.len(), 1);
    assert_eq!(prompts[0].fields.len(), 1);
    assert!(!prompts[0].fields[0].echo, "a password must be masked");
}

/// The fallback is a real password attempt, not a rubber stamp.
#[tokio::test]
async fn a_wrong_password_in_the_fallback_still_fails() {
    let (port, _) = serve_password_only("hunter2", &[russh::MethodKind::Password]).await;

    let (result, prompts) = connect_with(port, vec![Some(vec!["wrong".into()])]).await;

    assert!(
        matches!(result, Err(SshError::AuthFailed)),
        "expected AuthFailed, got {result:?}"
    );
    assert_eq!(prompts.len(), 1);
}

/// Cancelling the fallback prompt abandons the connection, same as cancelling
/// a server-driven round — it must not fall through to sending a blank.
#[tokio::test]
async fn cancelling_the_fallback_prompt_abandons_the_connection() {
    let (port, _) = serve_password_only("hunter2", &[russh::MethodKind::Password]).await;

    let (result, prompts) = connect_with(port, vec![None]).await;

    assert!(
        matches!(result, Err(SshError::AuthCancelled)),
        "expected AuthCancelled, got {result:?}"
    );
    assert_eq!(prompts.len(), 1);
}

/// When the server takes neither interactive auth nor a password, there is
/// nothing to prompt for — and the error has to say what it *does* want,
/// because "authentication failed" sends people to re-check a password that
/// was never going to be accepted.
#[tokio::test]
async fn a_key_only_server_reports_what_it_will_accept() {
    let (port, _) = serve_password_only("hunter2", &[russh::MethodKind::PublicKey]).await;

    let (result, prompts) = connect_with(port, vec![Some(vec!["hunter2".into()])]).await;

    match result {
        Err(SshError::AuthMethodUnavailable { remaining }) => {
            assert!(
                remaining.contains("publickey"),
                "expected the server's own method list, got {remaining:?}"
            );
        }
        other => panic!("expected AuthMethodUnavailable, got {other:?}"),
    }
    // Nothing to ask for, so nothing was asked.
    assert!(prompts.is_empty());
}
