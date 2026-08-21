use std::collections::{BTreeMap, HashMap};
use std::io::Read;

use base64::Engine;
use serde_json::{json, Value};

use crate::github_publication::{
    CheckState, FileContent, GithubRestPort, PublicationFile, PullRequest, MAX_FILE_BYTES,
};
use crate::secure_store::SecretBytes;

const API_ROOT: &str = "https://api.github.com";
const ACCEPT: &str = "application/vnd.github+json";
const API_VERSION: &str = "2022-11-28";

/// Base64 costs 4 characters per 3 input bytes, and the Contents API inserts a
/// newline every 60 characters. Bounding the encoded body off the publication
/// file limit keeps this cap from drifting away from `MAX_FILE_BYTES`.
const MAX_ENCODED_CONTENT_BYTES: usize = MAX_FILE_BYTES / 3 * 4 + MAX_FILE_BYTES / 45 + 1024;

/// A complete recursive tree can contain the rest of the static site as well as
/// the publication bundle. GitHub itself caps recursive trees at 100,000
/// entries; keeping the same explicit bound makes any future API drift fail
/// closed before it can become an unbounded in-memory comparison.
const MAX_GIT_TREE_ENTRIES: usize = 100_000;

/// A publication bundle is bounded at 256 files, so a diff larger than this is
/// remote drift rather than this publication's own change set.
const MAX_COMPARED_FILES: usize = 3_000;

/// Budget for a single JSON response body. The installer download is streamed
/// under an explicit cap; the control-plane responses share the same threat
/// model (a compromised edge or hostile proxy can stream without end), so they
/// are bounded too. The bound is derived from the largest legitimate body — a
/// blob read back for a `MAX_FILE_BYTES` file — plus room for the JSON envelope,
/// so it cannot be tightened into rejecting a publication the contract accepts.
const MAX_RESPONSE_BYTES: usize = MAX_ENCODED_CONTENT_BYTES + 64 * 1024;

/// GitHub's Contents API refuses to create or update a blob larger than about
/// 1 MB and serves reads above that limit with `"encoding":"none"`. Anything
/// bigger goes through the Git data API instead.
const CONTENTS_API_MAX_FILE_BYTES: usize = 1_000_000;

/// Listings are read page by page. The cap exists so a truncated listing is
/// reported as truncated: concluding "absent" from an unread page makes a
/// required check look forever pending and a finished deploy look undispatched.
const MAX_LIST_PAGES: u32 = 20;
const LIST_PAGE_SIZE: usize = 100;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HttpMethod {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

pub struct HttpRequest<'a> {
    pub method: HttpMethod,
    pub url: String,
    pub bearer_token: &'a str,
    pub body: Option<Value>,
}

pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

pub trait GithubHttpTransport: Send + Sync {
    fn send(&self, request: HttpRequest<'_>) -> Result<HttpResponse, String>;
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
    fn send(&self, request: HttpRequest<'_>) -> Result<HttpResponse, String> {
        if !request.url.starts_with("https://api.github.com/") {
            return Err("GITHUB_API_ORIGIN_INVALID".into());
        }
        let builder = match request.method {
            HttpMethod::Get => self.client.get(&request.url),
            HttpMethod::Post => self.client.post(&request.url),
            HttpMethod::Put => self.client.put(&request.url),
            HttpMethod::Patch => self.client.patch(&request.url),
            HttpMethod::Delete => self.client.delete(&request.url),
        }
        .bearer_auth(request.bearer_token)
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
        // Read one byte past the budget so the caller can tell "at the limit"
        // from "over it" without ever buffering an unbounded body.
        let mut bytes = Vec::new();
        response
            .take(MAX_RESPONSE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "GITHUB_API_RESPONSE_INVALID".to_string())?;
        let body =
            String::from_utf8(bytes).map_err(|_| "GITHUB_API_RESPONSE_INVALID".to_string())?;
        Ok(HttpResponse { status, body })
    }
}

pub struct GithubRestAdapter<T: GithubHttpTransport> {
    token: SecretBytes,
    transport: T,
    content_shas: HashMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct GitTreeEntryIdentity {
    mode: String,
    kind: String,
    sha: String,
}

impl GithubRestAdapter<ReqwestGithubTransport> {
    pub(crate) fn new(token: SecretBytes) -> Result<Self, String> {
        Ok(Self {
            token,
            transport: ReqwestGithubTransport::new()?,
            content_shas: HashMap::new(),
        })
    }
}

impl<T: GithubHttpTransport> GithubRestAdapter<T> {
    #[cfg(test)]
    fn with_transport(token: &str, transport: T) -> Self {
        Self {
            token: SecretBytes::new(token.as_bytes().to_vec()).expect("valid token fixture"),
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
            bearer_token: self.token.expose_str(),
            body,
        })?;
        // The transport reads under the same budget, but the invariant is
        // enforced here as well so a transport that ignores it fails closed
        // instead of handing an unbounded body to the JSON parser.
        if response.body.len() > MAX_RESPONSE_BYTES {
            return Err("GITHUB_API_RESPONSE_INVALID".into());
        }
        if matches!(response.status, 401 | 403) {
            Err("GITHUB_REAUTHORIZATION_REQUIRED".into())
        } else if accepted.contains(&response.status) {
            Ok(response)
        } else {
            Err(format!("GITHUB_API_HTTP_{}", response.status))
        }
    }

    fn json(&self, response: HttpResponse) -> Result<Value, String> {
        serde_json::from_str(&response.body).map_err(|_| "GITHUB_API_RESPONSE_INVALID".into())
    }

    fn complete_git_tree(
        &self,
        repository: &str,
        commit_sha: &str,
    ) -> Result<BTreeMap<String, GitTreeEntryIdentity>, String> {
        let commit = self.json(self.request(
            HttpMethod::Get,
            format!(
                "/repos/{repository}/git/commits/{}",
                encode_path(commit_sha)
            ),
            None,
            &[200],
        )?)?;
        let tree_sha = required_string(&commit, &["tree", "sha"])?;
        let value = self.json(self.request(
            HttpMethod::Get,
            format!(
                "/repos/{repository}/git/trees/{}?recursive=1",
                encode_path(&tree_sha)
            ),
            None,
            &[200],
        )?)?;
        match value.get("truncated").and_then(Value::as_bool) {
            Some(false) => {}
            Some(true) => return Err("GITHUB_TREE_TRUNCATED".into()),
            None => return Err("GITHUB_API_RESPONSE_INVALID".into()),
        }
        let entries = value
            .get("tree")
            .and_then(Value::as_array)
            .ok_or("GITHUB_API_RESPONSE_INVALID")?;
        if entries.len() > MAX_GIT_TREE_ENTRIES {
            return Err("GITHUB_API_RESPONSE_INVALID".into());
        }
        let mut files = BTreeMap::new();
        for entry in entries {
            let kind = required_string(entry, &["type"])?;
            if kind == "tree" {
                continue;
            }
            if kind != "blob" && kind != "commit" {
                return Err("GITHUB_API_RESPONSE_INVALID".into());
            }
            let path = required_string(entry, &["path"])?;
            let identity = GitTreeEntryIdentity {
                mode: required_string(entry, &["mode"])?,
                kind,
                sha: required_string(entry, &["sha"])?,
            };
            if files.insert(path, identity).is_some() {
                return Err("GITHUB_API_RESPONSE_INVALID".into());
            }
        }
        Ok(files)
    }

    fn put_file_via_git_data(
        &self,
        repository: &str,
        branch: &str,
        file: &PublicationFile,
    ) -> Result<(), String> {
        let parent = self.json(self.request(
            HttpMethod::Get,
            format!("/repos/{repository}/git/ref/heads/{}", encode_path(branch)),
            None,
            &[200],
        )?)?;
        let parent_sha = required_string(&parent, &["object", "sha"])?;
        let parent_commit = self.json(self.request(
            HttpMethod::Get,
            format!(
                "/repos/{repository}/git/commits/{}",
                encode_path(&parent_sha)
            ),
            None,
            &[200],
        )?)?;
        let parent_tree_sha = required_string(&parent_commit, &["tree", "sha"])?;
        let blob = self.json(self.request(
            HttpMethod::Post,
            format!("/repos/{repository}/git/blobs"),
            Some(json!({
                "content": base64::engine::general_purpose::STANDARD.encode(file_bytes(file)),
                "encoding": "base64"
            })),
            &[201],
        )?)?;
        let blob_sha = required_string(&blob, &["sha"])?;
        let tree = self.json(self.request(
            HttpMethod::Post,
            format!("/repos/{repository}/git/trees"),
            Some(json!({
                "base_tree": parent_tree_sha,
                "tree": [{
                    "path": file.path,
                    "mode": "100644",
                    "type": "blob",
                    "sha": blob_sha
                }]
            })),
            &[201],
        )?)?;
        let tree_sha = required_string(&tree, &["sha"])?;
        let commit = self.json(self.request(
            HttpMethod::Post,
            format!("/repos/{repository}/git/commits"),
            Some(json!({
                "message": format!("Blogbot publication: {}", file.path),
                "tree": tree_sha,
                "parents": [parent_sha]
            })),
            &[201],
        )?)?;
        let commit_sha = required_string(&commit, &["sha"])?;
        self.request(
            HttpMethod::Patch,
            format!("/repos/{repository}/git/refs/heads/{}", encode_path(branch)),
            Some(json!({"sha": commit_sha, "force": false})),
            &[200],
        )?;
        Ok(())
    }

    fn delete_ref_if_matches(
        &self,
        repository: &str,
        reference: &str,
        expected_sha: &str,
    ) -> Result<(), String> {
        let current = self.request(
            HttpMethod::Get,
            format!("/repos/{repository}/git/ref/{}", encode_path(reference)),
            None,
            &[200, 404],
        )?;
        if current.status == 404 {
            return Ok(());
        }
        let current = self.json(current)?;
        if required_string(&current, &["object", "sha"])? != expected_sha {
            return Err("GITHUB_PUBLICATION_REF_CONFLICT".into());
        }
        self.request(
            HttpMethod::Delete,
            format!("/repos/{repository}/git/refs/{}", encode_path(reference)),
            None,
            &[204, 404],
        )?;
        Ok(())
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

    fn base_contains_commit(
        &mut self,
        repository: &str,
        base_branch: &str,
        commit_sha: &str,
    ) -> Result<bool, String> {
        let value = self.json(self.request(
            HttpMethod::Get,
            format!(
                "/repos/{repository}/compare/{}...{}",
                encode_path(commit_sha),
                encode_path(base_branch)
            ),
            None,
            &[200],
        )?)?;
        // `identical` means the tip is the commit; `ahead` means the base
        // moved forward on top of it. `behind` or `diverged` means it left
        // the history, which is a revert or a force-push.
        match required_string(&value, &["status"])?.as_str() {
            "identical" | "ahead" => Ok(true),
            "behind" | "diverged" => Ok(false),
            _ => Err("GITHUB_API_RESPONSE_INVALID".into()),
        }
    }

    fn changed_paths(
        &mut self,
        repository: &str,
        base_sha: &str,
        head: &str,
    ) -> Result<Vec<String>, String> {
        // GitHub's compare endpoint exposes at most 300 paths, even when the
        // actual diff is larger. Comparing two complete, explicitly
        // untruncated recursive trees prevents an omitted unapproved path from
        // being waved through by that response cap.
        let base = self.complete_git_tree(repository, base_sha)?;
        let current = self.complete_git_tree(repository, head)?;
        let mut paths = base
            .keys()
            .chain(current.keys())
            .cloned()
            .collect::<Vec<_>>();
        paths.sort();
        paths.dedup();
        let mut changed = Vec::new();
        for path in paths {
            if base.get(&path) == current.get(&path) {
                continue;
            }
            changed.push(path);
            if changed.len() > MAX_COMPARED_FILES {
                return Err("GITHUB_API_RESPONSE_INVALID".into());
            }
        }
        Ok(changed)
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
            .insert(content_key(repository, branch, &file.path), sha.clone());
        let encoded = if value.get("encoding").and_then(Value::as_str) == Some("none") {
            let blob = self.json(self.request(
                HttpMethod::Get,
                format!("/repos/{repository}/git/blobs/{}", encode_path(&sha)),
                None,
                &[200],
            )?)?;
            encoded_file_content(&blob)?
        } else {
            encoded_file_content(&value)?
        };
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
        // The publication contract accepts files up to MAX_FILE_BYTES. The
        // Contents API cannot update larger blobs, so keep that contract intact
        // by committing them through Git's blob/tree/commit/ref primitives.
        if file_bytes(file).len() > CONTENTS_API_MAX_FILE_BYTES {
            return self.put_file_via_git_data(repository, branch, file);
        }
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
        let head = encode_query(&format!("{owner}:{branch}"));
        let base = encode_query(base_branch);
        // The pull request reconcile may merge is the open one. Asking for
        // `state=all` answered with whatever pull request GitHub listed first,
        // so a pull request a human had closed — or an unrelated older one for
        // the same head/base pair — was reused: reconcile bound to its head SHA
        // and then asked GitHub to merge something it refuses (405), which
        // reached the operator as an unexplained remote failure.
        let open = self.json(self.request(
            HttpMethod::Get,
            format!("/repos/{repository}/pulls?state=open&head={head}&base={base}&per_page=1"),
            None,
            &[200],
        )?)?;
        if let Some(value) = open
            .as_array()
            .ok_or("GITHUB_API_RESPONSE_INVALID")?
            .first()
        {
            return parse_pull(value).map(Some);
        }
        // Every pass after a successful merge still has to recognise its own
        // merged pull request, so the closed list is read too. A closed pull
        // request that was never merged is reported distinctly rather than
        // handed back as if it were still mergeable.
        let closed = self.json(self.request(
            HttpMethod::Get,
            format!(
                "/repos/{repository}/pulls?state=closed&head={head}&base={base}&per_page={LIST_PAGE_SIZE}"
            ),
            None,
            &[200],
        )?)?;
        let values = closed.as_array().ok_or("GITHUB_API_RESPONSE_INVALID")?;
        if let Some(merged) = values.iter().find(|value| is_merged(value)) {
            return parse_pull(merged).map(Some);
        }
        if values.is_empty() {
            return Ok(None);
        }
        Err("GITHUB_PULL_REQUEST_CLOSED".into())
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
        // A required check sitting on a later page used to read as `None`,
        // which the reconciler treats as pending, so publication waited
        // forever on a check that had already succeeded.
        let mut runs = Vec::new();
        for page in 1..=MAX_LIST_PAGES {
            let value = self.json(self.request(
                HttpMethod::Get,
                format!(
                    "/repos/{repository}/commits/{head_sha}/check-runs?filter=latest&per_page={LIST_PAGE_SIZE}&page={page}"
                ),
                None,
                &[200],
            )?)?;
            let batch = value
                .get("check_runs")
                .and_then(Value::as_array)
                .ok_or("GITHUB_API_RESPONSE_INVALID")?
                .clone();
            let complete = batch.len() < LIST_PAGE_SIZE;
            runs.extend(batch);
            if complete {
                break;
            }
            if page == MAX_LIST_PAGES {
                // Never report a truncated check set as the whole set.
                return Err("GITHUB_API_RESPONSE_INVALID".into());
            }
        }
        let mut result = BTreeMap::new();
        for run in &runs {
            let name = required_string(run, &["name"])?;
            let status = required_string(run, &["status"])?;
            // The engine's own aggregator (apps/publisher/src/github-effects.ts)
            // is the contract for what branch protection lets through: GitHub
            // concludes `skipped` for a path- or branch-filtered job and
            // `neutral` for an advisory one, and merges regardless. Reading
            // anything other than `success` as a failure left publication
            // waiting forever on a required check GitHub had already cleared.
            // An unrecognised or absent conclusion stays pending — a conclusion
            // this build cannot classify must never read as success.
            let state = if status != "completed" {
                CheckState::Pending
            } else {
                match run.get("conclusion").and_then(Value::as_str) {
                    Some("success") | Some("skipped") | Some("neutral") => CheckState::Success,
                    Some("failure")
                    | Some("cancelled")
                    | Some("timed_out")
                    | Some("action_required")
                    | Some("stale") => CheckState::Failed,
                    _ => CheckState::Pending,
                }
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
        let response = self.request(
            HttpMethod::Get,
            format!(
                "/repos/{repository}/branches/{}/protection/required_status_checks",
                encode_path(base_branch)
            ),
            None,
            &[200, 404],
        )?;
        // A base branch with no protection, or with protection but no required
        // status checks, answers 404. That is exactly the condition the caller
        // asks about, so it must read as "no guarantee" and surface the
        // actionable BASE_SHA_GUARANTEE_UNAVAILABLE, not as a remote failure
        // that tells the operator nothing about the missing protection.
        if response.status == 404 {
            return Ok(false);
        }
        let value = self.json(response)?;
        if value.get("strict").and_then(Value::as_bool) != Some(true) {
            return Ok(false);
        }
        let contexts = value
            .get("contexts")
            .and_then(Value::as_array)
            .ok_or("GITHUB_API_RESPONSE_INVALID")?;
        Ok(required_checks.iter().all(|required| {
            contexts
                .iter()
                .any(|context| context.as_str() == Some(required))
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
        // The intent ref above cannot answer whether the workflow was already
        // dispatched: it is created *before* the dispatch because it is the ref
        // the dispatch runs on, so a pass that died in between leaves it behind
        // with nothing running. The dispatched ref is written only after the
        // dispatch call returned, so its presence is proof the workflow was
        // already asked to run. Without it, the Actions listing below — which is
        // not immediately consistent with a dispatch — reported "no run yet" and
        // the next pass deployed the same merge a second time.
        let dispatched = self.request(
            HttpMethod::Get,
            format!("/repos/{repository}/git/ref/heads/blogbot/deploy-dispatched/{intent_key}"),
            None,
            &[200, 404],
        )?;
        if dispatched.status == 200 {
            let existing = self.json(dispatched)?;
            if required_string(&existing, &["object", "sha"])? != merge_sha {
                return Err("GITHUB_DEPLOY_INTENT_CONFLICT".into());
            }
            return Ok(true);
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
        // Durable evidence that the dispatch itself completed, written after it
        // and never before, so a retry that races the Actions listing sees
        // "already dispatched" instead of dispatching the same merge again. 422
        // is the ref already existing, which carries the same meaning.
        self.request(
            HttpMethod::Post,
            format!("/repos/{repository}/git/refs"),
            Some(json!({"ref": format!("refs/heads/blogbot/deploy-dispatched/{intent_key}"), "sha": merge_sha})),
            &[201, 422],
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

    fn cleanup_publication_refs(
        &mut self,
        repository: &str,
        branch: &str,
        expected_head_sha: &str,
        intent_key: &str,
        merge_sha: &str,
    ) -> Result<(), String> {
        // Marker refs are removed before the topic ref. If a pass stops midway,
        // the merged PR remains discoverable and Actions history reconstructs
        // dispatch state; every step is exact-SHA checked and 404-idempotent.
        self.delete_ref_if_matches(
            repository,
            &format!("heads/blogbot/deploy-dispatched/{intent_key}"),
            merge_sha,
        )?;
        self.delete_ref_if_matches(
            repository,
            &format!("heads/blogbot/deploy-intents/{intent_key}"),
            merge_sha,
        )?;
        self.delete_ref_if_matches(repository, &format!("heads/{branch}"), expected_head_sha)?;
        Ok(())
    }
}

/// `merged` exists only on the single-pull endpoint. The list endpoints used by
/// `find_pull_request` report a merge through `merged_at`, so reading the boolean
/// alone left every reconcile pass after a successful merge believing the
/// publication was still open. `merge_commit_sha` is deliberately NOT a merge
/// signal: GitHub fills it on open pull requests with a throwaway test-merge
/// commit.
fn is_merged(value: &Value) -> bool {
    value
        .get("merged")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || value.get("merged_at").and_then(Value::as_str).is_some()
}

fn parse_pull(value: &Value) -> Result<PullRequest, String> {
    let number = value
        .get("number")
        .and_then(Value::as_u64)
        .ok_or("GITHUB_API_RESPONSE_INVALID")?;
    let head_sha = required_string(value, &["head", "sha"])?;
    let merged = is_merged(value);
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

/// The Contents API returns a file body as base64 inside a JSON string. It must
/// not be read through `required_string`, whose 4 KiB bound exists for short
/// scalars such as SHAs and branch names: base64 of a 3 KiB file already exceeds
/// it, so every publication of a realistically sized article used to fail
/// content revalidation with `GITHUB_API_RESPONSE_INVALID` even though the
/// publication contract allows files up to `MAX_FILE_BYTES`.
fn encoded_file_content(value: &Value) -> Result<String, String> {
    match value.get("encoding").and_then(Value::as_str) {
        // The Contents API documents base64 for a file body, and an absent field
        // is decoded the same way so a trimmed response is not rejected outright.
        Some("base64") | None => {}
        // GitHub serves blobs above 1 MiB with `"encoding": "none"` and an empty
        // body. Report that distinctly instead of decoding an empty string and
        // silently concluding that the remote file differs.
        Some("none") => return Err("GITHUB_CONTENT_ENCODING_UNSUPPORTED".to_string()),
        Some(_) => return Err("GITHUB_API_RESPONSE_INVALID".to_string()),
    }
    let content = value
        .get("content")
        .and_then(Value::as_str)
        .ok_or("GITHUB_API_RESPONSE_INVALID")?;
    if content.is_empty() || content.len() > MAX_ENCODED_CONTENT_BYTES {
        return Err("GITHUB_API_RESPONSE_INVALID".to_string());
    }
    Ok(content.to_string())
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
        requests: Mutex<Vec<RecordedRequest>>,
        bearer_locations: Mutex<Vec<(usize, usize)>>,
    }

    struct RecordedRequest {
        method: HttpMethod,
        url: String,
        body: Option<Value>,
        authorization_present: bool,
    }

    impl FakeTransport {
        fn with_responses(responses: Vec<HttpResponse>) -> Self {
            Self {
                responses: Mutex::new(responses.into()),
                requests: Mutex::new(Vec::new()),
                bearer_locations: Mutex::new(Vec::new()),
            }
        }
    }

    impl GithubHttpTransport for FakeTransport {
        fn send(&self, request: HttpRequest<'_>) -> Result<HttpResponse, String> {
            self.bearer_locations.lock().unwrap().push((
                request.bearer_token.as_ptr() as usize,
                request.bearer_token.len(),
            ));
            self.requests.lock().unwrap().push(RecordedRequest {
                method: request.method,
                url: request.url,
                body: request.body,
                authorization_present: !request.bearer_token.is_empty(),
            });
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
        assert!(requests[0].authorization_present);
        assert!(requests[0].body.is_none());
    }

    #[test]
    fn request_construction_borrows_one_secret_buffer_and_records_no_plaintext_copy() {
        let transport = FakeTransport::with_responses(vec![
            response(200, r#"{"object":{"sha":"aaaaaaaa"}}"#),
            response(200, r#"{"object":{"sha":"bbbbbbbb"}}"#),
        ]);
        let mut github = GithubRestAdapter::with_transport("secret", transport);
        github.base_sha("owner/site", "main").unwrap();
        github.base_sha("owner/site", "release").unwrap();

        let locations = github.transport().bearer_locations.lock().unwrap();
        assert_eq!(locations.len(), 2);
        assert_eq!(locations[0], locations[1]);
        assert!(github
            .transport()
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|request| request.authorization_present));

        let source = include_str!("github_rest_adapter.rs");
        assert!(!source.contains(&["bearer_token", ": String"].concat()));
        assert!(!source.contains(&["self.token", ".clone()"].concat()));
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
    fn file_matches_reads_a_realistically_sized_article_body() {
        // A 6 KiB article encodes to ~8.2 KiB of base64. The short-scalar 4 KiB
        // bound used to reject it, so content revalidation failed terminally for
        // every publication larger than about 3 KiB.
        let body = vec![b'a'; 6 * 1024];
        let encoded = base64::engine::general_purpose::STANDARD.encode(&body);
        assert!(
            encoded.len() > 4096,
            "fixture must exceed the short-scalar bound"
        );
        let transport = FakeTransport::with_responses(vec![response(
            200,
            &format!(r#"{{"sha":"blob-sha","encoding":"base64","content":"{encoded}"}}"#),
        )]);
        let mut github = GithubRestAdapter::with_transport("secret", transport);
        let file = PublicationFile {
            path: "content/tr/story.md".into(),
            content: FileContent::Bytes(body),
        };

        assert!(github.file_matches("owner/site", "topic/x", &file).unwrap());
    }

    #[test]
    fn file_matches_rejects_a_git_blob_response_without_base64() {
        // The Contents API uses `none` above 1 MiB, so the adapter follows its
        // SHA into the Git blob API. That second endpoint must still return a
        // bounded base64 body; another `none` must fail closed.
        let transport = FakeTransport::with_responses(vec![
            response(200, r#"{"sha":"blob-sha","encoding":"none","content":""}"#),
            response(200, r#"{"sha":"blob-sha","encoding":"none","content":""}"#),
        ]);
        let mut github = GithubRestAdapter::with_transport("secret", transport);
        let file = PublicationFile {
            path: "content/tr/story.md".into(),
            content: FileContent::Bytes(vec![1, 2, 3]),
        };

        assert_eq!(
            github.file_matches("owner/site", "topic/x", &file),
            Err("GITHUB_CONTENT_ENCODING_UNSUPPORTED".to_string())
        );
    }

    #[test]
    fn large_file_read_falls_back_to_the_git_blob_api() {
        let bytes = vec![7_u8, 8, 9];
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let transport = FakeTransport::with_responses(vec![
            response(
                200,
                r#"{"sha":"large-blob-sha","encoding":"none","content":""}"#,
            ),
            response(
                200,
                &format!(r#"{{"sha":"large-blob-sha","encoding":"base64","content":"{encoded}"}}"#),
            ),
        ]);
        let mut github = GithubRestAdapter::with_transport("secret", transport);
        let file = PublicationFile {
            path: "public/images/hero.webp".into(),
            content: FileContent::Bytes(bytes),
        };

        assert!(github.file_matches("owner/site", "topic/x", &file).unwrap());
        let requests = github.transport().requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[1]
            .url
            .ends_with("/repos/owner/site/git/blobs/large-blob-sha"));
    }

    #[test]
    fn approved_file_over_one_megabyte_is_committed_through_the_git_data_api() {
        let bytes = vec![5_u8; CONTENTS_API_MAX_FILE_BYTES + 1];
        assert!(bytes.len() <= MAX_FILE_BYTES);
        let transport = FakeTransport::with_responses(vec![
            response(200, r#"{"object":{"sha":"parent-commit"}}"#),
            response(200, r#"{"tree":{"sha":"parent-tree"}}"#),
            response(201, r#"{"sha":"new-blob"}"#),
            response(201, r#"{"sha":"new-tree"}"#),
            response(201, r#"{"sha":"new-commit"}"#),
            response(200, "{}"),
        ]);
        let mut github = GithubRestAdapter::with_transport("secret", transport);
        let file = PublicationFile {
            path: "public/images/hero.webp".into(),
            content: FileContent::Bytes(bytes),
        };

        github.put_file("owner/site", "topic/x", &file).unwrap();

        let requests = github.transport().requests.lock().unwrap();
        assert_eq!(requests.len(), 6);
        assert!(requests[0]
            .url
            .ends_with("/repos/owner/site/git/ref/heads/topic/x"));
        assert!(requests[1]
            .url
            .ends_with("/repos/owner/site/git/commits/parent-commit"));
        assert!(requests[2].url.ends_with("/repos/owner/site/git/blobs"));
        assert_eq!(requests[2].body.as_ref().unwrap()["encoding"], "base64");
        assert!(requests[3].url.ends_with("/repos/owner/site/git/trees"));
        assert_eq!(
            requests[3].body.as_ref().unwrap()["base_tree"],
            "parent-tree"
        );
        assert_eq!(
            requests[3].body.as_ref().unwrap()["tree"][0]["path"],
            "public/images/hero.webp"
        );
        assert!(requests[4].url.ends_with("/repos/owner/site/git/commits"));
        assert_eq!(
            requests[4].body.as_ref().unwrap()["parents"][0],
            "parent-commit"
        );
        assert_eq!(requests[5].method, HttpMethod::Patch);
        assert_eq!(requests[5].body.as_ref().unwrap()["force"], false);
    }

    #[test]
    fn changed_paths_are_derived_from_complete_untruncated_git_trees() {
        let transport = FakeTransport::with_responses(vec![
            response(200, r#"{"tree":{"sha":"base-tree"}}"#),
            response(
                200,
                r#"{"truncated":false,"tree":[{"path":"content","mode":"040000","type":"tree","sha":"base-dir"},{"path":"content/approved.md","mode":"100644","type":"blob","sha":"old"},{"path":"unchanged.txt","mode":"100644","type":"blob","sha":"same"}]}"#,
            ),
            response(200, r#"{"tree":{"sha":"head-tree"}}"#),
            response(
                200,
                r#"{"truncated":false,"tree":[{"path":"content","mode":"040000","type":"tree","sha":"head-dir"},{"path":"content/approved.md","mode":"100644","type":"blob","sha":"new"},{"path":"extra.txt","mode":"100644","type":"blob","sha":"extra"},{"path":"unchanged.txt","mode":"100644","type":"blob","sha":"same"}]}"#,
            ),
        ]);
        let mut github = GithubRestAdapter::with_transport("secret", transport);

        assert_eq!(
            github
                .changed_paths("owner/site", "base-sha", "head-sha")
                .unwrap(),
            vec!["content/approved.md".to_string(), "extra.txt".to_string()]
        );
        let requests = github.transport().requests.lock().unwrap();
        assert!(requests[0]
            .url
            .ends_with("/repos/owner/site/git/commits/base-sha"));
        assert!(requests[1]
            .url
            .ends_with("/repos/owner/site/git/trees/base-tree?recursive=1"));
        assert!(requests[2]
            .url
            .ends_with("/repos/owner/site/git/commits/head-sha"));
        assert!(requests[3]
            .url
            .ends_with("/repos/owner/site/git/trees/head-tree?recursive=1"));
    }

    #[test]
    fn changed_paths_fail_closed_when_either_git_tree_is_truncated() {
        let transport = FakeTransport::with_responses(vec![
            response(200, r#"{"tree":{"sha":"base-tree"}}"#),
            response(200, r#"{"truncated":true,"tree":[]}"#),
        ]);
        let mut github = GithubRestAdapter::with_transport("secret", transport);

        assert_eq!(
            github.changed_paths("owner/site", "base-sha", "head-sha"),
            Err("GITHUB_TREE_TRUNCATED".to_string())
        );
    }

    #[test]
    fn list_endpoint_merge_state_is_read_from_merged_at() {
        // `GET /repos/{repo}/pulls` never returns the `merged` boolean; that
        // field exists only on the single-pull endpoint. Reading it made every
        // post-merge reconcile pass believe the publication was still unmerged.
        let transport = FakeTransport::with_responses(vec![
            response(200, "[]"),
            response(
                200,
                r#"[{"number":7,"state":"closed","head":{"sha":"cccccccc"},"merged_at":"2026-08-19T10:00:00Z","merge_commit_sha":"dddddddd"}]"#,
            ),
        ]);
        let mut github = GithubRestAdapter::with_transport("secret", transport);

        let pull = github
            .find_pull_request("owner/site", "topic/x", "main")
            .unwrap()
            .unwrap();
        assert!(
            pull.merged,
            "a merged pull request must be reported as merged"
        );
        assert_eq!(pull.merge_sha.as_deref(), Some("dddddddd"));
    }

    #[test]
    fn an_open_pull_request_is_never_reported_as_merged() {
        // GitHub fills `merge_commit_sha` on an OPEN pull request with its
        // throwaway test-merge commit, so that field alone must never be read
        // as proof of a merge.
        let transport = FakeTransport::with_responses(vec![response(
            200,
            r#"[{"number":7,"state":"open","head":{"sha":"cccccccc"},"merged_at":null,"merge_commit_sha":"eeeeeeee"}]"#,
        )]);
        let mut github = GithubRestAdapter::with_transport("secret", transport);

        let pull = github
            .find_pull_request("owner/site", "topic/x", "main")
            .unwrap()
            .unwrap();
        assert!(!pull.merged, "an open pull request must never look merged");
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
            response(201, "{}"),
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
        assert!(requests[0].url.contains("state=open"));
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
            response(201, "{}"),
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
        assert_eq!(requests.len(), 3);
        assert!(requests
            .iter()
            .all(|request| request.method == HttpMethod::Get));
    }

    #[test]
    fn http_and_malformed_json_fail_with_bounded_secret_free_errors() {
        let transport = FakeTransport::with_responses(vec![
            response(401, r#"{"message":"token ghp_SECRET rejected"}"#),
            response(403, r#"{"message":"forbidden"}"#),
            response(200, "not json"),
        ]);
        let mut github = GithubRestAdapter::with_transport("ghp_SECRET", transport);
        let first = github.base_sha("owner/site", "main").unwrap_err();
        let second = github.base_sha("owner/site", "main").unwrap_err();
        let third = github.base_sha("owner/site", "main").unwrap_err();
        assert_eq!(first, "GITHUB_REAUTHORIZATION_REQUIRED");
        assert_eq!(second, "GITHUB_REAUTHORIZATION_REQUIRED");
        assert_eq!(third, "GITHUB_API_RESPONSE_INVALID");
        assert!(
            !first.contains("SECRET") && !second.contains("SECRET") && !third.contains("SECRET")
        );
    }

    #[test]
    fn check_conclusions_follow_the_publisher_contract() {
        // `skipped` is what GitHub concludes for a path-filtered required job and
        // `neutral` for an advisory one; branch protection merges both, so
        // reporting them as failures blocked the publication for good.
        let transport = FakeTransport::with_responses(vec![response(
            200,
            r#"{"check_runs":[
                {"name":"build","status":"completed","conclusion":"skipped"},
                {"name":"advisory","status":"completed","conclusion":"neutral"},
                {"name":"test","status":"completed","conclusion":"failure"},
                {"name":"cancelled","status":"completed","conclusion":"cancelled"},
                {"name":"timed-out","status":"completed","conclusion":"timed_out"},
                {"name":"stale-run","status":"completed","conclusion":"stale"},
                {"name":"future","status":"completed","conclusion":"something_new"},
                {"name":"headless","status":"completed","conclusion":null}
            ]}"#,
        )]);
        let mut github = GithubRestAdapter::with_transport("secret", transport);

        let checks = github.checks("owner/site", "cccccccc").unwrap();
        assert_eq!(checks["build"], CheckState::Success);
        assert_eq!(checks["advisory"], CheckState::Success);
        assert_eq!(checks["test"], CheckState::Failed);
        assert_eq!(checks["cancelled"], CheckState::Failed);
        assert_eq!(checks["timed-out"], CheckState::Failed);
        assert_eq!(checks["stale-run"], CheckState::Failed);
        // A conclusion this build does not know must never read as success.
        assert_eq!(checks["future"], CheckState::Pending);
        assert_eq!(checks["headless"], CheckState::Pending);
    }

    #[test]
    fn missing_branch_protection_reads_as_no_guarantee() {
        // GitHub answers 404 when the base branch has no protection or no
        // required status checks. Returning an HTTP error there hid the
        // actionable BASE_SHA_GUARANTEE_UNAVAILABLE behind a generic remote
        // failure.
        let transport =
            FakeTransport::with_responses(vec![response(404, r#"{"message":"Not Found"}"#)]);
        let mut github = GithubRestAdapter::with_transport("secret", transport);

        assert!(!github
            .requires_up_to_date_base("owner/site", "main", &["ci/test".to_string()])
            .unwrap());
    }

    #[test]
    fn a_closed_unmerged_pull_request_is_never_handed_back_as_mergeable() {
        let transport = FakeTransport::with_responses(vec![
            response(200, "[]"),
            response(
                200,
                r#"[{"number":7,"state":"closed","head":{"sha":"cccccccc"},"merged_at":null,"merge_commit_sha":"eeeeeeee"}]"#,
            ),
        ]);
        let mut github = GithubRestAdapter::with_transport("secret", transport);

        assert_eq!(
            github.find_pull_request("owner/site", "topic/x", "main"),
            Err("GITHUB_PULL_REQUEST_CLOSED".to_string())
        );
        let requests = github.transport().requests.lock().unwrap();
        assert!(requests[0].url.contains("state=open"));
        assert!(requests[1].url.contains("state=closed"));
    }

    #[test]
    fn an_absent_pull_request_is_reported_absent() {
        let transport =
            FakeTransport::with_responses(vec![response(200, "[]"), response(200, "[]")]);
        let mut github = GithubRestAdapter::with_transport("secret", transport);

        assert!(github
            .find_pull_request("owner/site", "topic/x", "main")
            .unwrap()
            .is_none());
    }

    #[test]
    fn a_dispatched_deploy_is_not_dispatched_again_before_its_run_is_listed() {
        // GitHub's Actions listing lags a dispatch, so the first pass after a
        // dispatch sees the intent ref but no run. That used to read as "not
        // dispatched" and deployed the same merge commit twice.
        let transport = FakeTransport::with_responses(vec![
            // First pass: no intent ref, no dispatch proof, no run yet.
            response(404, "{}"),
            response(404, "{}"),
            response(200, r#"{"workflow_runs":[]}"#),
            // The dispatch itself: intent ref, dispatch, dispatch proof.
            response(201, "{}"),
            response(204, ""),
            response(201, "{}"),
            // Second pass: the run is still not listed, but the proof is there.
            response(200, r#"{"object":{"sha":"dddddddd"}}"#),
            response(200, r#"{"object":{"sha":"dddddddd"}}"#),
        ]);
        let mut github = GithubRestAdapter::with_transport("secret", transport);

        assert!(!github
            .deploy_intent_exists("owner/site", "intent-1", "deploy.yml", "dddddddd")
            .unwrap());
        github
            .dispatch_deploy("owner/site", "deploy.yml", "main", "intent-1", "dddddddd")
            .unwrap();
        assert!(github
            .deploy_intent_exists("owner/site", "intent-1", "deploy.yml", "dddddddd")
            .unwrap());

        let requests = github.transport().requests.lock().unwrap();
        let dispatches = requests
            .iter()
            .filter(|request| request.url.contains("/dispatches"))
            .count();
        assert_eq!(dispatches, 1, "the deploy workflow must be dispatched once");
    }

    #[test]
    fn a_response_over_the_budget_is_rejected_instead_of_buffered() {
        // The installer download is capped for the same reason: a compromised
        // edge or hostile proxy can stream a body without end.
        let transport = FakeTransport::with_responses(vec![response(
            200,
            &format!(
                r#"{{"object":{{"sha":"{}"}}}}"#,
                "a".repeat(MAX_RESPONSE_BYTES)
            ),
        )]);
        let mut github = GithubRestAdapter::with_transport("secret", transport);

        assert_eq!(
            github.base_sha("owner/site", "main"),
            Err("GITHUB_API_RESPONSE_INVALID".to_string())
        );
    }

    #[test]
    fn successful_cleanup_deletes_only_three_exact_matching_refs_and_is_idempotent() {
        let transport = FakeTransport::with_responses(vec![
            response(200, r#"{"object":{"sha":"dddddddd"}}"#),
            response(204, ""),
            response(200, r#"{"object":{"sha":"dddddddd"}}"#),
            response(204, ""),
            response(200, r#"{"object":{"sha":"cccccccc"}}"#),
            response(204, ""),
            response(404, "{}"),
            response(404, "{}"),
            response(404, "{}"),
        ]);
        let mut github = GithubRestAdapter::with_transport("secret", transport);

        github
            .cleanup_publication_refs(
                "owner/site",
                "blogbot/publication/topic-1",
                "cccccccc",
                "intent-1",
                "dddddddd",
            )
            .unwrap();
        github
            .cleanup_publication_refs(
                "owner/site",
                "blogbot/publication/topic-1",
                "cccccccc",
                "intent-1",
                "dddddddd",
            )
            .unwrap();

        let requests = github.transport().requests.lock().unwrap();
        let deletes = requests
            .iter()
            .filter(|request| request.method == HttpMethod::Delete)
            .collect::<Vec<_>>();
        assert_eq!(deletes.len(), 3);
        assert!(deletes[0]
            .url
            .ends_with("/git/refs/heads/blogbot/deploy-dispatched/intent-1"));
        assert!(deletes[1]
            .url
            .ends_with("/git/refs/heads/blogbot/deploy-intents/intent-1"));
        assert!(deletes[2]
            .url
            .ends_with("/git/refs/heads/blogbot/publication/topic-1"));
    }

    #[test]
    fn cleanup_never_deletes_a_ref_that_moved_to_an_unexpected_commit() {
        let transport =
            FakeTransport::with_responses(vec![response(200, r#"{"object":{"sha":"eeeeeeee"}}"#)]);
        let mut github = GithubRestAdapter::with_transport("secret", transport);

        assert_eq!(
            github.cleanup_publication_refs(
                "owner/site",
                "blogbot/publication/topic-1",
                "cccccccc",
                "intent-1",
                "dddddddd",
            ),
            Err("GITHUB_PUBLICATION_REF_CONFLICT".to_string())
        );
        let requests = github.transport().requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].method, HttpMethod::Get);
    }
}
