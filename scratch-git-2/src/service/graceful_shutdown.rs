use std::sync::OnceLock;

use tokio::signal;
use tokio::sync::watch;

/// The process-wide shutdown channel, set by [`spawn_shutdown_handler`]. Lets code far from
/// `run()` (e.g. a manually triggered maintenance step) observe SIGTERM without threading a
/// receiver through every constructor.
static SHUTDOWN_RX: OnceLock<watch::Receiver<bool>> = OnceLock::new();

/// A receiver on the process shutdown channel. Before `spawn_shutdown_handler` ran (tests),
/// returns a receiver that never fires.
pub fn subscribe() -> watch::Receiver<bool> {
    if let Some(rx) = SHUTDOWN_RX.get() {
        return rx.clone();
    }
    let (tx, rx) = watch::channel(false);
    std::mem::forget(tx); // keep the channel alive so `changed()` pends forever
    rx
}

async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    tokio::select! {
        _ = ctrl_c => { tracing::info!("Received SIGINT, starting graceful shutdown..."); },
        _ = terminate => { tracing::info!("Received SIGTERM, starting graceful shutdown..."); },
    }
}

/// Returns two shutdown receivers — one for the API server, one for the git backend.
/// Spawns a background task that waits for SIGINT/SIGTERM and notifies both.
pub fn spawn_shutdown_handler() -> (watch::Receiver<bool>, watch::Receiver<bool>) {
    let (tx, _) = watch::channel(false);
    let api_rx = tx.subscribe();
    let git_rx = tx.subscribe();
    let _ = SHUTDOWN_RX.set(tx.subscribe());

    tokio::spawn(async move {
        shutdown_signal().await;
        let _ = tx.send(true);
    });

    (api_rx, git_rx)
}
