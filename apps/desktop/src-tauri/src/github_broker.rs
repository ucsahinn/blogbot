use serde::Serialize;

/// Native-only boundary for future GitHub App traffic. The WebView receives
/// only state and a non-sensitive user action; it can never receive a token.
pub struct GitHubBroker {
    // Keep the HTTPS client native. No request is made until a separately
    // approved GitHub App configuration exists.
    _http: reqwest::Client,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubBrokerStatus {
    pub status: &'static str,
    pub writes: bool,
    pub network: bool,
    pub detail: &'static str,
}

impl GitHubBroker {
    pub fn new() -> Self {
        Self { _http: reqwest::Client::new() }
    }

    pub fn status(&self) -> GitHubBrokerStatus {
        GitHubBrokerStatus {
            status: "unconfigured",
            writes: false,
            network: false,
            detail: "GitHub App broker yapılandırılmadı; gerçek oturum ve yayın kapalı tutuluyor.",
        }
    }

    pub fn begin_device_authorization(&self) -> GitHubBrokerStatus {
        self.status()
    }
}

#[cfg(test)]
mod tests {
    use super::GitHubBroker;

    #[test]
    fn unconfigured_broker_never_claims_network_or_write_access() {
        let state = GitHubBroker::new().begin_device_authorization();
        assert_eq!(state.status, "unconfigured");
        assert!(!state.network);
        assert!(!state.writes);
    }
}
