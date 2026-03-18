#[path = "mod.rs"]
mod service;

#[path = "../shared/mod.rs"]
mod shared;

#[path = "../cli/mod.rs"]
mod cli;

#[tokio::main]
async fn main() {
    service::run().await;
}
