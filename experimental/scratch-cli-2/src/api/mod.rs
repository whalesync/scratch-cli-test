pub mod auth;
pub mod connections;
pub mod jobs;
pub mod linked;
pub mod syncs;
pub mod workbooks;

use anyhow::{bail, Context, Result};
use reqwest::blocking::Response;
use serde::Serialize;

const DEFAULT_USER_AGENT: &str = "Scratch-CLI";

pub struct Client {
    http: reqwest::blocking::Client,
    base_url: String,
    api_token: Option<String>,
    verbose: bool,
    version: String,
}

impl Client {
    pub fn new(
        base_url: &str,
        api_token: Option<&str>,
        verbose: bool,
    ) -> Result<Self> {
        let http = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .context("failed to create HTTP client")?;

        Ok(Self {
            http,
            base_url: base_url.trim_end_matches('/').to_string(),
            api_token: api_token.map(|s| s.to_string()),
            verbose,
            version: env!("CARGO_PKG_VERSION").to_string(),
        })
    }

    fn build_url(&self, path: &str) -> String {
        format!("{}/cli/v1{}", self.base_url, path)
    }

    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::blocking::RequestBuilder {
        let url = self.build_url(path);
        if self.verbose {
            eprintln!("--> {} {}", method, url);
        }

        let mut req = self
            .http
            .request(method, &url)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .header(
                "User-Agent",
                format!("{}/{}", DEFAULT_USER_AGENT, self.version),
            )
            .header("X-Scratch-CLI-Version", &self.version);

        if let Some(ref token) = self.api_token {
            req = req.header("Authorization", format!("API-Token {}", token));
        }

        req
    }

    fn handle_response(&self, resp: Response) -> Result<Response> {
        if self.verbose {
            eprintln!("<-- {}", resp.status());
        }
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().unwrap_or_default();
            bail!("server returned status {}: {}", status.as_u16(), body);
        }
        Ok(resp)
    }

    pub fn get(&self, path: &str) -> Result<Response> {
        let resp = self
            .request(reqwest::Method::GET, path)
            .send()
            .context("request failed")?;
        self.handle_response(resp)
    }

    pub fn get_with_query(&self, path: &str, query: &[(&str, &str)]) -> Result<Response> {
        let url = self.build_url(path);
        if self.verbose {
            eprintln!("--> GET {} (with query params)", url);
        }

        let mut req = self
            .http
            .get(&url)
            .query(query)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .header(
                "User-Agent",
                format!("{}/{}", DEFAULT_USER_AGENT, self.version),
            )
            .header("X-Scratch-CLI-Version", &self.version);

        if let Some(ref token) = self.api_token {
            req = req.header("Authorization", format!("API-Token {}", token));
        }

        let resp = req.send().context("request failed")?;
        self.handle_response(resp)
    }

    pub fn post<T: Serialize>(&self, path: &str, body: &T) -> Result<Response> {
        let resp = self
            .request(reqwest::Method::POST, path)
            .json(body)
            .send()
            .context("request failed")?;
        self.handle_response(resp)
    }

    pub fn post_empty(&self, path: &str) -> Result<Response> {
        let resp = self
            .request(reqwest::Method::POST, path)
            .send()
            .context("request failed")?;
        self.handle_response(resp)
    }

    pub fn patch<T: Serialize>(&self, path: &str, body: &T) -> Result<Response> {
        let resp = self
            .request(reqwest::Method::PATCH, path)
            .json(body)
            .send()
            .context("request failed")?;
        self.handle_response(resp)
    }

    pub fn delete(&self, path: &str) -> Result<Response> {
        let resp = self
            .request(reqwest::Method::DELETE, path)
            .send()
            .context("request failed")?;
        self.handle_response(resp)
    }
}
