use std::collections::{BTreeMap, HashMap};

use base64::Engine;
use serde_json::{json, Value};

use crate::github_publication::{
    CheckState, FileContent, GithubRestPort, PublicationFile, PullRequest,
};

const API_ROOT: &str = "https://api.github.com";
const ACCEPT: &str = "application/vnd.github+json";
const API_VERSION: &str = "2022-11-28";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HttpMethod {
    Get,
    Post,
    Put,
}

pub struct HttpRequest {
    pub method: HttpMethod,
    pub url: String,
    pub bearer_token: String,
    pub body: Option<Value>,
}

pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

pub trait GithubHttpTransport: Send + Sync {
    fn send(&self, request: HttpRequest) -> Result<HttpResponse, String>;
}

pub struct ReqwestGithubTransport {
    client: reqwest::blocking::Client,
}

impl ReqwestGithubTransport {
    pub fn new() -> Result<Self, String> {
        let client = reqwest::blocking::Client::builder()
            .user_agent("Blogbot/0.1")
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|_| "GITHUB_CLIENT_UNAVAILABLE".to_string())?;
        Ok(Self { client })
    }
}

impl GithubHttpTransport for ReqwestGithubTransport {
    fn send(&self, request: HttpRequest) -> Result<HttpResponse, String> {
        if !request.url.starts_with("https://api.github.com/") {
            return Err("GITHUB_API_ORIGIN_INVALID".into());
        }
        let builder = match request.method {
            HttpMethod::Get => self.client.get(&request.url),
            HttpMethod::Post => self.client.post(&request.url),
            HttpMethod::Put => self.client.put(&request.url),
        }
        .bearer_auth(&request.bearer_token)
        .header("Accept", ACCEPT)
        .header("X-GitHub-Api-Version", API_VERSION);
        let builder = match request.body {
            Some(body) => builder.json(&body),
            None => builder,
        };
        let response = builder
            .send()
            .map_err(|_| "GITHUB_API_NETWORK_FAILED".to_string())?;
        let status = response.status().as_u16();
        let body = response
            .text()
            .map_err(|_| "GITHUB_API_RESPONSE_INVALID".to_string())?;
        Ok(HttpResponse { status, body })
    }
}

pub struct GithubRestAdapter<T: GithubHttpTransport> {
    token: String,
    transport: T,
    content_shas: HashMap<String, String>,
}

impl GithubRestAdapter<ReqwestGithubTransport> {
    pub fn new(token: String) -> Result<Self, String> {
        if token.trim().is_empty() {
            return Err("GITHUB_TOKEN_MISSING".into());
        }
        Ok(Self::with_transport(token, ReqwestGithubTransport::new()?))
    }
}

impl<T: GithubHttpTransport> GithubRestAdapter<T> {
    pub fn with_transport(token: impl Into<String>, transport: T) -> Self {
        Self {
            token: token.into(),
            transport,
            content_shas: HashMap::new(),
        }
    }

    #[cfg(test)]
    fn transport(&self) -> &T {
        &self.transport
    }

    fn request(
        &self,
        method: HttpMethod,
        path_and_query: String,
        body: Option<Value>,
        accepted: &[u16],
    ) -> Result<HttpResponse, String> {
        let response = self.transport.send(HttpRequest {
            method,
            url: format!("{API_ROOT}{path_and_query}"),
            bearer_token: self.token.clone(),
            body,
        })?;
        if accepted.contains(&response.status) {
            Ok(response)
        } else {
            Err(format!("GITHUB_API_HTTP_{}", response.status))
        }
    }

    fn json(&self, response: HttpResponse) -> Result<Value, String> {
        serde_json::from_str(&response.body).map_err(|_| "GITHUB_API_RESPONSE_INVALID".into())
    }
}

impl<T: GithubHttpTransport> GithubRestPort for GithubRestAdapter<T> {
    fn base_sha(&mut self, repository: &str, base_branch: &str) -> Result<String, String> {
        let value = self.json(self.request(
            HttpMethod::Get,
            format!(
                "/repos/{repository}/git/ref/heads/{}",
                encode_path(base_branch)
            ),
            None,
            &[200],
        )?)?;
        required_string(&value, &["object", "sha"])
    }

    fn find_branch(&mut self, repository: &str, branch: &str) -> Result<Option<String>, String> {
        let response = self.request(
            HttpMethod::Get,
            format!("/repos/{repository}/git/ref/heads/{}", encode_path(branch)),
            None,
            &[200, 404],
        )?;
        if response.status == 404 {
            return Ok(None);
        }
        Ok(Some(required_string(
            &self.json(response)?,
            &["object", "sha"],
        )?))
    }

    fn file_matches(
        &mut self,
        repository: &str,
        branch: &str,
        file: &PublicationFile,
    ) -> Result<bool, String> {
        let response = self.request(
            HttpMethod::Get,
            format!(
                "/repos/{repository}/contents/{}?ref={}",
                encode_path(&file.path),
                encode_query(branch)
            ),
            None,
            &[200, 404],
        )?;
        if response.status == 404 {
            return Ok(false);
        }
        let value = self.json(response)?;
        let sha = required_string(&value, &["sha"])?;
        self.content_shas
            .insert(content_key(repository, branch, &file.path), sha);
        let encoded = required_string(&value, &["content"])?;
        let remote = base64::engine::general_purpose::STANDARD
            .decode(
                encoded
                    .bytes()
                    .filter(|byte| !byte.is_ascii_whitespace())
                    .collect::<Vec<_>>(),
            )
            .map_err(|_| "GITHUB_API_RESPONSE_INVALID".to_string())?;
        Ok(remote == file_bytes(file))
    }

    fn create_branch(
        &mut self,
        repository: &str,
        branch: &str,
        base_sha: &str,
    ) -> Result<(), String> {
        self.request(
            HttpMethod::Post,
            format!("/repos/{repository}/git/refs"),
            Some(json!({"ref": format!("refs/heads/{branch}"), "sha": base_sha})),
            &[201],
        )?;
        Ok(())
    }

    fn put_file(
        &mut self,
        repository: &str,
        branch: &str,
        file: &PublicationFile,
    ) -> Result<(), String> {
        let mut body = json!({
            "message": format!("Blogbot publication: {}", file.path),
            "content": base64::engine::general_purpose::STANDARD.encode(file_bytes(file)),
            "branch": branch,
        });
        if let Some(sha) = self
            .content_shas
            .get(&content_key(repository, branch, &file.path))
        {
            body["sha"] = Value::String(sha.clone());
        }
        self.request(
            HttpMethod::Put,
            format!("/repos/{repository}/contents/{}", encode_path(&file.path)),
            Some(body),
            &[200, 201],
        )?;
        Ok(())
    }

    fn find_pull_request(
        &mut self,
        repository: &str,
        branch: &str,
        base_branch: &str,
    ) -> Result<Option<PullRequest>, String> {
        let owner = repository
            .split('/')
            .next()
            .ok_or("GITHUB_REPOSITORY_INVALID")?;
        let value = self.json(self.request(
            HttpMethod::Get,
            format!(
                "/repos/{repository}/pulls?state=all&head={}&base={}&per_page=1",
                encode_query(&format!("{owner}:{branch}")),
                encode_query(base_branch)
            ),
            None,
            &[200],
        )?)?;
        let values = value.as_array().ok_or("GITHUB_API_RESPONSE_INVALID")?;
        values.first().map(parse_pull).transpose()
    }

    fn create_pull_request(
        &mut self,
        repository: &str,
        branch: &str,
        base_branch: &str,
        key: &str,
    ) -> Result<PullRequest, String> {
        let value = self.json(self.request(
            HttpMethod::Post,
            format!("/repos/{repository}/pulls"),
            Some(json!({
                "title": format!("Blogbot publication {key}"),
                "body": format!("Blogbot idempotency key: {key}"),
                "head": branch,
                "base": base_branch,
            })),
            &[201],
        )?)?;
        parse_pull(&value)
    }

    fn checks(
        &mut self,
        repository: &str,
        head_sha: &str,
    ) -> Result<BTreeMap<String, CheckState>, String> {
        let value = self.json(self.request(
            HttpMethod::Get,
            format!("/repos/{repository}/commits/{head_sha}/check-runs?filter=latest&per_page=100"),
            None,
            &[200],
        )?)?;
        let runs = value
            .get("check_runs")
            .and_then(Value::as_array)
            .ok_or("GITHUB_API_RESPONSE_INVALID")?;
        let mut result = BTreeMap::new();
        for run in runs {
            let name = required_string(run, &["name"])?;
            let status = required_string(run, &["status"])?;
            let state = if status != "completed" {
                CheckState::Pending
            } else if run.get("conclusion").and_then(Value::as_str) == Some("success") {
                CheckState::Success
            } else {
                CheckState::Failed
            };
            result.insert(name, state);
        }
        Ok(result)
    }

    fn requires_up_to_date_base(
        &mut self,
        repository: &str,
        base_branch: &str,
        required_checks: &[String],
    ) -> Result<bool, String> {
        let value = self.json(self.request(
            HttpMethod::Get,
            format!("/repos/{repository}/branches/{}/protection/required_status_checks", encode_path(base_branch)),
            None,
            &[200],
        )?)?;
        if value.get("strict").and_then(Value::as_bool) != Some(true) {
            return Ok(false);
        }
        let contexts = value
            .get("contexts")
            .and_then(Value::as_array)
            .ok_or("GITHUB_API_RESPONSE_INVALID")?;
        Ok(required_checks.iter().all(|required| {
            contexts.iter().any(|context| context.as_str() == Some(required))
        }))
    }

    fn squash_merge(
        &mut self,
        repository: &str,
        number: u64,
        expected_head_sha: &str,
    ) -> Result<String, String> {
        let value = self.json(self.request(
            HttpMethod::Put,
            format!("/repos/{repository}/pulls/{number}/merge"),
            Some(json!({"merge_method": "squash", "sha": expected_head_sha})),
            &[200],
        )?)?;
        if value.get("merged").and_then(Value::as_bool) != Some(true) {
            return Err("GITHUB_MERGE_REJECTED".into());
        }
        required_string(&value, &["sha"])
    }

    fn deploy_intent_exists(
        &mut self,
        repository: &str,
        intent_key: &str,
        workflow: &str,
        merge_sha: &str,
    ) -> Result<bool, String> {
        let response = self.request(
            HttpMethod::Get,
            format!("/repos/{repository}/git/ref/heads/blogbot/deploy-intents/{intent_key}"),
            None,
            &[200, 404],
        )?;
        if response.status == 200 {
            let existing = self.json(response)?;
            if required_string(&existing, &["object", "sha"])? != merge_sha {
                return Err("GITHUB_DEPLOY_INTENT_CONFLICT".into());
            }
        }
        let value = self.json(self.request(
            HttpMethod::Get,
            format!(
                "/repos/{repository}/actions/runs?event=workflow_dispatch&head_sha={}&per_page=100",
                encode_query(merge_sha)
            ),
            None,
            &[200],
        )?)?;
        let runs = value
            .get("workflow_runs")
            .and_then(Value::as_array)
            .ok_or("GITHUB_API_RESPONSE_INVALID")?;
        Ok(runs.iter().any(|run| {
            run.get("head_sha").and_then(Value::as_str) == Some(merge_sha)
                && run.get("head_branch").and_then(Value::as_str)
                    == Some(format!("blogbot/deploy-intents/{intent_key}").as_str())
                && run.get("path").and_then(Value::as_str)
                    == Some(format!(".github/workflows/{workflow}").as_str())
        }))
    }

    fn dispatch_deploy(
        &mut self,
        repository: &str,
        workflow: &str,
        _base_branch: &str,
        intent_key: &str,
        merge_sha: &str,
    ) -> Result<(), String> {
        let marker = self.request(
            HttpMethod::Post,
            format!("/repos/{repository}/git/refs"),
            Some(json!({"ref": format!("refs/heads/blogbot/deploy-intents/{intent_key}"), "sha": merge_sha})),
            &[201, 422],
        )?;
        if marker.status == 422 {
            let existing = self.json(self.request(
                HttpMethod::Get,
                format!("/repos/{repository}/git/ref/heads/blogbot/deploy-intents/{intent_key}"),
                None,
                &[200],
            )?)?;
            if required_string(&existing, &["object", "sha"])? != merge_sha {
                return Err("GITHUB_DEPLOY_INTENT_CONFLICT".into());
            }
        }
        let intent_ref = format!("blogbot/deploy-intents/{intent_key}");
        self.request(
            HttpMethod::Post,
            format!("/repos/{repository}/actions/workflows/{}/dispatches", encode_path(workflow)),
            Some(json!({"ref": intent_ref, "inputs": {"intent_key": intent_key, "merge_sha": merge_sha}})),
            &[204],
        )?;
        Ok(())
    }

    fn deploy_verified(
        &mut self,
        repository: &str,
        workflow: &str,
        intent_key: &str,
        merge_sha: &str,
    ) -> Result<bool, String> {
        let value = self.json(self.request(
            HttpMethod::Get,
            format!(
                "/repos/{repository}/actions/runs?event=workflow_dispatch&head_sha={}&per_page=100",
                encode_query(merge_sha)
            ),
            None,
            &[200],
        )?)?;
        let runs = value
            .get("workflow_runs")
            .and_then(Value::as_array)
            .ok_or("GITHUB_API_RESPONSE_INVALID")?;
        Ok(runs.iter().any(|run| {
            run.get("head_sha").and_then(Value::as_str) == Some(merge_sha)
                && run.get("head_branch").and_then(Value::as_str)
                    == Some(format!("blogbot/deploy-intents/{intent_key}").as_str())
                && run.get("conclusion").and_then(Value::as_str) == Some("success")
                && run.get("path").and_then(Value::as_str)
                    == Some(format!(".github/workflows/{workflow}").as_str())
        }))
    }
}

fn parse_pull(value: &Value) -> Result<PullRequest, String> {
    let number = value
        .get("number")
        .and_then(Value::as_u64)
        .ok_or("GITHUB_API_RESPONSE_INVALID")?;
    let head_sha = required_string(value, &["head", "sha"])?;
    let merged = value
        .get("merged")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let merge_sha = value
        .get("merge_commit_sha")
        .and_then(Value::as_str)
        .map(str::to_string);
    Ok(PullRequest {
        number,
        head_sha,
        merged,
        merge_sha,
    })
}

fn required_string(value: &Value, path: &[&str]) -> Result<String, String> {
    let mut current = value;
    for segment in path {
        current = current.get(*segment).ok_or("GITHUB_API_RESPONSE_INVALID")?;
    }
    current
        .as_str()
        .filter(|value| !value.is_empty() && value.len() <= 4096)
        .map(str::to_string)
        .ok_or_else(|| "GITHUB_API_RESPONSE_INVALID".into())
}

fn content_key(repository: &str, branch: &str, path: &str) -> String {
    format!("{repository}\0{branch}\0{path}")
}

fn file_bytes(file: &PublicationFile) -> &[u8] {
    match &file.content {
        FileContent::Text(value) => value.as_bytes(),
        FileContent::Bytes(value) => value,
    }
}

fn encode_path(value: &str) -> String {
    value
        .split('/')
        .map(percent_encode)
        .collect::<Vec<_>>()
        .join("/")
}

fn encode_query(value: &str) -> String {
    percent_encode(value)
}

fn percent_encode(value: &str) -> String {
    let mut result = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            result.push(byte as char);
        } else {
            result.push_str(&format!("%{byte:02X}"));
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeTransport {
        responses: Mutex<VecDeque<HttpResponse>>,
        requests: Mutex<Vec<HttpRequest>>,
    }

    impl FakeTransport {
        fn with_responses(responses: Vec<HttpResponse>) -> Self {
            Self {
                responses: Mutex::new(responses.into()),
                requests: Mutex::new(Vec::new()),
            }
        }
    }

    impl GithubHttpTransport for FakeTransport {
        fn send(&self, request: HttpRequest) -> Result<HttpResponse, String> {
            self.requests.lock().unwrap().push(request);
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| "missing fake response".into())
        }
    }

    fn response(status: u16, body: &str) -> HttpResponse {
        HttpResponse {
            status,
            body: body.into(),
        }
    }

    #[test]
    fn base_lookup_uses_fixed_github_api_and_encoded_ref() {
        let transport =
            FakeTransport::with_responses(vec![response(200, r#"{"object":{"sha":"aaaaaaaa"}}"#)]);
        let mut github = GithubRestAdapter::with_transport("secret", transport);

        assert_eq!(
            github.base_sha("owner/site", "release/v1").unwrap(),
            "aaaaaaaa"
        );
        let requests = github.transport().requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].method, HttpMethod::Get);
        assert_eq!(
            requests[0].url,
            "https://api.github.com/repos/owner/site/git/ref/heads/release/v1"
        );
        assert_eq!(requests[0].bearer_token, "secret");
        assert!(requests[0].body.is_none());
    }

    #[test]
    fn content_update_carries_existing_blob_sha_and_base64_bytes() {
        let encoded = base64::engine::general_purpose::STANDARD.encode([0_u8, 1, 2]);
        let transport = FakeTransport::with_responses(vec![
            response(
                200,
                &format!(r#"{{"sha":"blob-sha","content":"{encoded}"}}"#),
            ),
            response(200, "{}"),
        ]);
        let mut github = GithubRestAdapter::with_transport("secret", transport);
        let file = PublicationFile {
            path: "public/a b.bin".into(),
            content: FileContent::Bytes(vec![9, 8]),
        };

        assert!(!github.file_matches("owner/site", "topic/x", &file).unwrap());
        github.put_file("owner/site", "topic/x", &file).unwrap();

        let requests = github.transport().requests.lock().unwrap();
        assert!(requests[0]
            .url
            .ends_with("/contents/public/a%20b.bin?ref=topic%2Fx"));
        let body = requests[1].body.as_ref().unwrap();
        assert_eq!(body["sha"], "blob-sha");
        assert_eq!(
            body["content"],
            base64::engine::general_purpose::STANDARD.encode([9_u8, 8])
        );
        assert_eq!(body["branch"], "topic/x");
    }

    #[test]
    fn pull_checks_merge_and_deploy_requests_preserve_safety_contracts() {
        let transport = FakeTransport::with_responses(vec![
            response(
                200,
                r#"[{"number":7,"head":{"sha":"cccccccc"},"merged":false,"merge_commit_sha":null}]"#,
            ),
            response(
                200,
                r#"{"check_runs":[{"name":"ci/test","status":"completed","conclusion":"success"},{"name":"ci/lint","status":"in_progress","conclusion":null}]}"#,
            ),
            response(200, r#"{"merged":true,"sha":"dddddddd"}"#),
            response(201, "{}"),
            response(204, ""),
            response(
                200,
                r#"{"workflow_runs":[{"head_sha":"dddddddd","head_branch":"blogbot/deploy-intents/intent-1","conclusion":"success","path":".github/workflows/deploy.yml"}]}"#,
            ),
        ]);
        let mut github = GithubRestAdapter::with_transport("secret", transport);

        let pull = github
            .find_pull_request("owner/site", "topic/x", "main")
            .unwrap()
            .unwrap();
        assert_eq!(pull.number, 7);
        let checks = github.checks("owner/site", "cccccccc").unwrap();
        assert_eq!(checks["ci/test"], CheckState::Success);
        assert_eq!(checks["ci/lint"], CheckState::Pending);
        assert_eq!(
            github.squash_merge("owner/site", 7, "cccccccc").unwrap(),
            "dddddddd"
        );
        github
            .dispatch_deploy("owner/site", "deploy.yml", "main", "intent-1", "dddddddd")
            .unwrap();
        assert!(github
            .deploy_verified("owner/site", "deploy.yml", "intent-1", "dddddddd")
            .unwrap());

        let requests = github.transport().requests.lock().unwrap();
        assert!(requests[0].url.contains("head=owner%3Atopic%2Fx"));
        assert_eq!(requests[2].body.as_ref().unwrap()["merge_method"], "squash");
        assert_eq!(requests[2].body.as_ref().unwrap()["sha"], "cccccccc");
        assert_eq!(
            requests[3].body.as_ref().unwrap()["ref"],
            "refs/heads/blogbot/deploy-intents/intent-1"
        );
        assert_eq!(
            requests[4].body.as_ref().unwrap()["ref"],
            "blogbot/deploy-intents/intent-1"
        );
        assert_eq!(
            requests[4].body.as_ref().unwrap()["inputs"]["merge_sha"],
            "dddddddd"
        );
    }

    #[test]
    fn existing_deploy_marker_must_match_the_exact_merge_sha() {
        let matching = FakeTransport::with_responses(vec![
            response(422, r#"{"message":"already exists"}"#),
            response(200, r#"{"object":{"sha":"dddddddd"}}"#),
            response(204, ""),
        ]);
        let mut github = GithubRestAdapter::with_transport("secret", matching);
        github
            .dispatch_deploy("owner/site", "deploy.yml", "main", "intent-1", "dddddddd")
            .expect("matching durable marker");

        let conflicting = FakeTransport::with_responses(vec![
            response(422, r#"{"message":"validation failed"}"#),
            response(200, r#"{"object":{"sha":"eeeeeeee"}}"#),
        ]);
        let mut github = GithubRestAdapter::with_transport("secret", conflicting);
        assert_eq!(
            github
                .dispatch_deploy("owner/site", "deploy.yml", "main", "intent-1", "dddddddd")
                .unwrap_err(),
            "GITHUB_DEPLOY_INTENT_CONFLICT"
        );
    }

    #[test]
    fn missing_marker_reconciles_an_exact_existing_workflow_run() {
        let transport = FakeTransport::with_responses(vec![
            response(404, "{}"),
            response(
                200,
                r#"{"workflow_runs":[{"head_sha":"dddddddd","head_branch":"blogbot/deploy-intents/intent-1","status":"in_progress","conclusion":null,"path":".github/workflows/deploy.yml"}]}"#,
            ),
        ]);
        let mut github = GithubRestAdapter::with_transport("secret", transport);

        assert!(github
            .deploy_intent_exists("owner/site", "intent-1", "deploy.yml", "dddddddd")
            .unwrap());
        let requests = github.transport().requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests
            .iter()
            .all(|request| request.method == HttpMethod::Get));
    }

    #[test]
    fn http_and_malformed_json_fail_with_bounded_secret_free_errors() {
        let transport = FakeTransport::with_responses(vec![
            response(401, r#"{"message":"token ghp_SECRET rejected"}"#),
            response(200, "not json"),
        ]);
        let mut github = GithubRestAdapter::with_transport("ghp_SECRET", transport);
        let first = github.base_sha("owner/site", "main").unwrap_err();
        let second = github.base_sha("owner/site", "main").unwrap_err();
        assert_eq!(first, "GITHUB_API_HTTP_401");
        assert_eq!(second, "GITHUB_API_RESPONSE_INVALID");
        assert!(!first.contains("SECRET") && !second.contains("SECRET"));
    }
}
