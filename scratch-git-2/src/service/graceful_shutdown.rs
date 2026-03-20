use tokio::signal;
use tokio::sync::watch;

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

    tokio::spawn(async move {
        shutdown_signal().await;
        let _ = tx.send(true);
    });

    (api_rx, git_rx)
}
