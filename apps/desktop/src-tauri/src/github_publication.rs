use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

const MAX_FILES: usize = 256;
const MAX_FILE_BYTES: usize = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 50 * 1024 * 1024;
const RETRY_AFTER_SECONDS: u32 = 30;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FileContent {
    Text(String),
    Bytes(Vec<u8>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicationFile {
    pub path: String,
    pub content: FileContent,
}

/// Immutable adapter policy that was part of the approved engine preview.
/// The native publisher treats this as an allow-list, never as a renderer hint.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicationBundlePolicy {
    pub adapter_id: String,
    pub manifest_path: String,
    pub allowed_path_prefixes: Vec<String>,
}

impl PublicationFile {
    fn bytes(&self) -> &[u8] {
        match &self.content {
            FileContent::Text(value) => value.as_bytes(),
            FileContent::Bytes(value) => value,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApprovedClaim {
    pub repository: String,
    pub base_branch: String,
    pub approved_base_sha: String,
    pub approved_revision_hash: String,
    pub approved_files_sha: String,
    pub approved_head_sha: Option<String>,
    pub revision_id: String,
    pub idempotency_key: String,
    pub adapter_version: String,
    pub bundle_policy: PublicationBundlePolicy,
    pub files: Vec<PublicationFile>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicationConfig {
    pub required_checks: Vec<String>,
    pub deploy_workflow: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PullRequest {
    pub number: u64,
    pub head_sha: String,
    pub merged: bool,
    pub merge_sha: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CheckState {
    Pending,
    Success,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PublicationStage {
    WaitingForChecks,
    WaitingForDeployVerification,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReconcileResult {
    pub status: &'static str,
    pub stage: PublicationStage,
    pub retry_after_seconds: u32,
    pub last_error: Option<String>,
    pub result_ref: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicationError {
    pub code: &'static str,
    pub safe_message: String,
}

impl PublicationError {
    fn validation(code: &'static str, message: &str) -> Self {
        Self {
            code,
            safe_message: message.to_string(),
        }
    }

    fn remote(operation: &str) -> Self {
        Self {
            code: "REMOTE_FAILURE",
            safe_message: format!("GitHub {operation} failed; retry is safe"),
        }
    }
}

pub trait GithubRestPort {
    fn base_sha(&mut self, repository: &str, base_branch: &str) -> Result<String, String>;
    fn find_branch(&mut self, repository: &str, branch: &str) -> Result<Option<String>, String>;
    fn file_matches(
        &mut self,
        repository: &str,
        branch: &str,
        file: &PublicationFile,
    ) -> Result<bool, String>;
    fn create_branch(
        &mut self,
        repository: &str,
        branch: &str,
        base_sha: &str,
    ) -> Result<(), String>;
    fn put_file(
        &mut self,
        repository: &str,
        branch: &str,
        file: &PublicationFile,
    ) -> Result<(), String>;
    fn find_pull_request(
        &mut self,
        repository: &str,
        branch: &str,
        base_branch: &str,
    ) -> Result<Option<PullRequest>, String>;
    fn create_pull_request(
        &mut self,
        repository: &str,
        branch: &str,
        base_branch: &str,
        key: &str,
    ) -> Result<PullRequest, String>;
    fn checks(
        &mut self,
        repository: &str,
        head_sha: &str,
    ) -> Result<BTreeMap<String, CheckState>, String>;
    /// GitHub must enforce that required checks are rerun against the current
    /// base before an unattended merge is allowed.
    fn requires_up_to_date_base(
        &mut self,
        repository: &str,
        base_branch: &str,
        required_checks: &[String],
    ) -> Result<bool, String>;
    fn squash_merge(
        &mut self,
        repository: &str,
        number: u64,
        expected_head_sha: &str,
    ) -> Result<String, String>;
    fn deploy_intent_exists(
        &mut self,
        repository: &str,
        intent_key: &str,
        workflow: &str,
        merge_sha: &str,
    ) -> Result<bool, String>;
    fn dispatch_deploy(
        &mut self,
        repository: &str,
        workflow: &str,
        base_branch: &str,
        intent_key: &str,
        merge_sha: &str,
    ) -> Result<(), String>;
    fn deploy_verified(
        &mut self,
        repository: &str,
        workflow: &str,
        intent_key: &str,
        merge_sha: &str,
    ) -> Result<bool, String>;
}

pub fn reconcile(
    claim: &ApprovedClaim,
    config: &PublicationConfig,
    github: &mut impl GithubRestPort,
) -> Result<ReconcileResult, PublicationError> {
    validate(claim, config)?;
    let branch = deterministic_branch(&claim.idempotency_key);
    let mut result_ref = format!("{}/{}", claim.repository, branch);
    let base_sha = github
        .base_sha(&claim.repository, &claim.base_branch)
        .map_err(|_| PublicationError::remote("base lookup"))?;
    let mut pull = github
        .find_pull_request(&claim.repository, &branch, &claim.base_branch)
        .map_err(|_| PublicationError::remote("pull request lookup"))?;
    let merged_sha = pull
        .as_ref()
        .filter(|pull| pull.merged)
        .and_then(|pull| pull.merge_sha.as_deref());
    match merged_sha {
        Some(merge_sha) if base_sha != merge_sha => {
            return Err(PublicationError::validation(
                "MERGED_BASE_SHA_MISMATCH",
                "merged pull request is not the current approved base",
            ));
        }
        None if base_sha != claim.approved_base_sha => {
            return Err(PublicationError::validation(
                "BASE_SHA_MISMATCH",
                "approved base SHA no longer matches",
            ));
        }
        _ => {}
    }
    if pull.is_none() {
        let branch_sha = github
            .find_branch(&claim.repository, &branch)
            .map_err(|_| PublicationError::remote("branch lookup"))?;
        if let Some(existing) = branch_sha {
            if existing != claim.approved_base_sha {
                return Err(PublicationError::validation(
                    "REMOTE_STATE_INVALID",
                    "publication branch has an unexpected head",
                ));
            }
        } else {
            github
                .create_branch(&claim.repository, &branch, &claim.approved_base_sha)
                .map_err(|_| PublicationError::remote("branch creation"))?;
        }
        for file in &claim.files {
            let matches = github
                .file_matches(&claim.repository, &branch, file)
                .map_err(|_| PublicationError::remote("content lookup"))?;
            if !matches {
                github
                    .put_file(&claim.repository, &branch, file)
                    .map_err(|_| PublicationError::remote("content write"))?;
            }
        }
        pull = Some(
            github
                .create_pull_request(
                    &claim.repository,
                    &branch,
                    &claim.base_branch,
                    &claim.idempotency_key,
                )
                .map_err(|_| PublicationError::remote("pull request creation"))?,
        );
    }
    let pull = pull.expect("pull request is established");
    if let Some(approved_head) = &claim.approved_head_sha {
        if &pull.head_sha != approved_head {
            return Err(PublicationError::validation(
                "HEAD_SHA_MISMATCH",
                "pull request head no longer matches the approved claim",
            ));
        }
    }
    for file in &claim.files {
        let matches = github
            .file_matches(&claim.repository, &branch, file)
            .map_err(|_| PublicationError::remote("content revalidation"))?;
        if !matches {
            return Err(PublicationError::validation(
                "REMOTE_STATE_INVALID",
                "publication branch no longer matches the approved files",
            ));
        }
    }
    result_ref = format!("pr:{}:{}", pull.number, pull.head_sha);
    let checks = github
        .checks(&claim.repository, &pull.head_sha)
        .map_err(|_| PublicationError::remote("check lookup"))?;
    let mut failed = false;
    let mut pending = false;
    for required in &config.required_checks {
        match checks.get(required) {
            Some(CheckState::Success) => {}
            Some(CheckState::Failed) => failed = true,
            Some(CheckState::Pending) | None => pending = true,
        }
    }
    if failed {
        return Ok(waiting(
            PublicationStage::WaitingForChecks,
            result_ref,
            Some("required checks failed"),
        ));
    }
    if pending {
        return Ok(waiting(
            PublicationStage::WaitingForChecks,
            result_ref,
            None,
        ));
    }

    let merge_sha = if pull.merged {
        let merge_sha = pull.merge_sha.ok_or_else(|| {
            PublicationError::validation(
                "REMOTE_STATE_INVALID",
                "merged pull request has no merge SHA",
            )
        })?;
        let current_base = github
            .base_sha(&claim.repository, &claim.base_branch)
            .map_err(|_| PublicationError::remote("base verification"))?;
        if current_base != merge_sha {
            return Err(PublicationError::validation(
                "MERGED_BASE_SHA_MISMATCH",
                "merged pull request is not the current approved base",
            ));
        }
        merge_sha
    } else {
        let current_base = github
            .base_sha(&claim.repository, &claim.base_branch)
            .map_err(|_| PublicationError::remote("pre-merge base verification"))?;
        if current_base != claim.approved_base_sha {
            return Err(PublicationError::validation(
                "BASE_SHA_MISMATCH",
                "approved base SHA changed before merge",
            ));
        }
        let strict_base = github
            .requires_up_to_date_base(
                &claim.repository,
                &claim.base_branch,
                &config.required_checks,
            )
            .map_err(|_| PublicationError::remote("branch protection lookup"))?;
        if !strict_base {
            return Err(PublicationError::validation(
                "BASE_SHA_GUARANTEE_UNAVAILABLE",
                "automatic merge requires strict up-to-date required checks",
            ));
        }
        // GitHub's strict required-check protection then rejects a merge whose
        // checks were not evaluated against the current target base, while the
        // endpoint atomically binds the approved PR head SHA.
        github
            .squash_merge(&claim.repository, pull.number, &pull.head_sha)
            .map_err(|_| PublicationError::remote("squash merge"))?
    };
    let intent_key = deploy_intent_key(claim, &merge_sha);
    let result_ref = format!("deploy:{intent_key}:{merge_sha}");
    let dispatched = github
        .deploy_intent_exists(
            &claim.repository,
            &intent_key,
            &config.deploy_workflow,
            &merge_sha,
        )
        .map_err(|_| PublicationError::remote("deploy intent lookup"))?;
    if !dispatched {
        github
            .dispatch_deploy(
                &claim.repository,
                &config.deploy_workflow,
                &claim.base_branch,
                &intent_key,
                &merge_sha,
            )
            .map_err(|_| PublicationError::remote("workflow dispatch"))?;
    }
    let verified = github
        .deploy_verified(
            &claim.repository,
            &config.deploy_workflow,
            &intent_key,
            &merge_sha,
        )
        .map_err(|_| PublicationError::remote("deployment verification"))?;
    if !verified {
        return Ok(waiting(
            PublicationStage::WaitingForDeployVerification,
            result_ref,
            None,
        ));
    }
    Ok(ReconcileResult {
        status: "SUCCEEDED",
        stage: PublicationStage::WaitingForDeployVerification,
        retry_after_seconds: 0,
        last_error: None,
        result_ref,
    })
}

fn waiting(stage: PublicationStage, result_ref: String, error: Option<&str>) -> ReconcileResult {
    ReconcileResult {
        status: "UNKNOWN",
        stage,
        retry_after_seconds: RETRY_AFTER_SECONDS,
        last_error: error.map(str::to_string),
        result_ref,
    }
}

fn validate(claim: &ApprovedClaim, config: &PublicationConfig) -> Result<(), PublicationError> {
    if !safe_repository(&claim.repository)
        || !safe_branch(&claim.base_branch)
        || !safe_sha(&claim.approved_base_sha)
        || !safe_sha(&claim.approved_revision_hash)
        || claim.revision_id.trim().is_empty()
        || claim.idempotency_key.trim().is_empty()
        || claim.idempotency_key.len() > 200
    {
        return Err(PublicationError::validation(
            "INVALID_CLAIM",
            "publication claim is invalid",
        ));
    }
    if config.required_checks.is_empty()
        || config
            .required_checks
            .iter()
            .any(|v| v.trim().is_empty() || v.len() > 200)
        || config.required_checks.iter().collect::<BTreeSet<_>>().len()
            != config.required_checks.len()
    {
        return Err(PublicationError::validation(
            "INVALID_CONFIG",
            "required checks must be nonempty and unique",
        ));
    }
    if !safe_workflow(&config.deploy_workflow) {
        return Err(PublicationError::validation(
            "INVALID_CONFIG",
            "deploy workflow is unsafe",
        ));
    }
    if claim.files.is_empty() || claim.files.len() > MAX_FILES {
        return Err(PublicationError::validation(
            "INVALID_FILES",
            "publication file count is out of bounds",
        ));
    }
    if !safe_adapter_identity(&claim.adapter_version, &claim.bundle_policy.adapter_id)
        || !safe_path(&claim.bundle_policy.manifest_path)
        || claim.bundle_policy.allowed_path_prefixes.is_empty()
        || claim.bundle_policy.allowed_path_prefixes.len() > MAX_FILES
    {
        return Err(PublicationError::validation(
            "INVALID_BUNDLE_POLICY",
            "publication adapter bundle policy is invalid",
        ));
    }
    let allowed_paths = claim
        .bundle_policy
        .allowed_path_prefixes
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    if allowed_paths.len() != claim.bundle_policy.allowed_path_prefixes.len()
        || !allowed_paths.contains(claim.bundle_policy.manifest_path.as_str())
    {
        return Err(PublicationError::validation(
            "INVALID_BUNDLE_POLICY",
            "publication adapter bundle policy is ambiguous",
        ));
    }
    let mut paths = BTreeSet::new();
    let mut total = 0usize;
    for file in &claim.files {
        if !safe_path(&file.path)
            || !allowed_paths.contains(file.path.as_str())
            || !paths.insert(file.path.as_str())
            || file.bytes().is_empty()
            || file.bytes().len() > MAX_FILE_BYTES
        {
            return Err(PublicationError::validation(
                "INVALID_FILES",
                "publication file is invalid",
            ));
        }
        total = total.checked_add(file.bytes().len()).ok_or_else(|| {
            PublicationError::validation("INVALID_FILES", "publication is too large")
        })?;
    }
    if total > MAX_TOTAL_BYTES {
        return Err(PublicationError::validation(
            "INVALID_FILES",
            "publication is too large",
        ));
    }
    if claim_files_digest(&claim.files) != claim.approved_files_sha.to_ascii_lowercase() {
        return Err(PublicationError::validation(
            "FILES_HASH_MISMATCH",
            "publication files no longer match the approved claim",
        ));
    }
    Ok(())
}

fn safe_repository(value: &str) -> bool {
    let parts: Vec<_> = value.split('/').collect();
    parts.len() == 2
        && parts.iter().all(|p| {
            !p.is_empty()
                && p.len() <= 100
                && p.chars()
                    .all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
        })
}
fn safe_branch(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && !value.starts_with('/')
        && !value.ends_with('/')
        && !value.contains("..")
        && !value.contains('\\')
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._/-".contains(c))
}
fn safe_sha(value: &str) -> bool {
    (7..=64).contains(&value.len()) && value.chars().all(|c| c.is_ascii_hexdigit())
}
fn safe_workflow(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && !value.contains('/')
        && !value.contains("..")
        && (value.ends_with(".yml") || value.ends_with(".yaml"))
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
}
fn safe_adapter_identity(value: &str, adapter_id: &str) -> bool {
    !adapter_id.is_empty()
        && adapter_id.len() <= 100
        && adapter_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
        && value.len() <= 200
        && value
            .strip_prefix(adapter_id)
            .and_then(|suffix| suffix.strip_prefix('@'))
            .is_some_and(|version| !version.trim().is_empty() && version.len() <= 100)
}
fn safe_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && !value.starts_with('/')
        && !value.ends_with('/')
        && !value.contains('\\')
        && !value.contains('\0')
        && value
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}
fn deterministic_branch(key: &str) -> String {
    format!("blogbot/publication-{}", hex_digest(key.as_bytes()))
}
fn deploy_intent_key(claim: &ApprovedClaim, merge_sha: &str) -> String {
    hex_digest(
        format!(
            "deploy\0{}\0{}\0{}",
            claim.idempotency_key, claim.revision_id, merge_sha
        )
        .as_bytes(),
    )
}
fn hex_digest(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}
fn claim_files_digest(files: &[PublicationFile]) -> String {
    let mut ordered: Vec<_> = files.iter().collect();
    ordered.sort_by(|left, right| left.path.cmp(&right.path));
    let mut digest = Sha256::new();
    for file in ordered {
        digest.update(file.path.as_bytes());
        digest.update([0]);
        digest.update((file.bytes().len() as u64).to_be_bytes());
        digest.update(file.bytes());
    }
    format!("{:x}", digest.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct FakeGithub {
        base: String,
        branch: Option<String>,
        files: BTreeSet<String>,
        pull: Option<PullRequest>,
        checks: BTreeMap<String, CheckState>,
        intent: bool,
        verified: bool,
        strict_base: bool,
        actions: Vec<String>,
        failure: Option<String>,
    }

    impl FakeGithub {
        fn with_base_sha(value: &str) -> Self {
            Self {
                base: value.into(),
                ..Self::default()
            }
        }
        fn writes(&self) -> Vec<&str> {
            self.actions
                .iter()
                .filter(|a| a.starts_with("WRITE:"))
                .map(String::as_str)
                .collect()
        }
        fn ready() -> Self {
            let mut value = Self::with_base_sha("aaaaaaaa");
            value.pull = Some(PullRequest {
                number: 7,
                head_sha: "cccccccc".into(),
                merged: false,
                merge_sha: None,
            });
            value.checks.insert("ci/test".into(), CheckState::Success);
            value.checks.insert("ci/lint".into(), CheckState::Success);
            value.files.insert("content/tr/article.md".into());
            value.files.insert("public/image.bin".into());
            value.strict_base = true;
            value
        }
    }

    impl GithubRestPort for FakeGithub {
        fn base_sha(&mut self, _: &str, _: &str) -> Result<String, String> {
            Ok(self.base.clone())
        }
        fn find_branch(&mut self, _: &str, _: &str) -> Result<Option<String>, String> {
            Ok(self.branch.clone())
        }
        fn file_matches(
            &mut self,
            _: &str,
            _: &str,
            file: &PublicationFile,
        ) -> Result<bool, String> {
            Ok(self.files.contains(&file.path))
        }
        fn create_branch(&mut self, _: &str, branch: &str, _: &str) -> Result<(), String> {
            self.actions.push(format!("WRITE:create-branch:{branch}"));
            self.branch = Some(self.base.clone());
            Ok(())
        }
        fn put_file(
            &mut self,
            _: &str,
            branch: &str,
            file: &PublicationFile,
        ) -> Result<(), String> {
            self.actions
                .push(format!("WRITE:put:{branch}:{}", file.path));
            self.files.insert(file.path.clone());
            Ok(())
        }
        fn find_pull_request(
            &mut self,
            _: &str,
            _: &str,
            _: &str,
        ) -> Result<Option<PullRequest>, String> {
            if let Some(value) = &self.failure {
                return Err(value.clone());
            }
            Ok(self.pull.clone())
        }
        fn create_pull_request(
            &mut self,
            _: &str,
            _: &str,
            _: &str,
            _: &str,
        ) -> Result<PullRequest, String> {
            self.actions.push("WRITE:create-pr".into());
            let pull = PullRequest {
                number: 7,
                head_sha: "cccccccc".into(),
                merged: false,
                merge_sha: None,
            };
            self.pull = Some(pull.clone());
            Ok(pull)
        }
        fn checks(&mut self, _: &str, _: &str) -> Result<BTreeMap<String, CheckState>, String> {
            Ok(self.checks.clone())
        }
        fn requires_up_to_date_base(
            &mut self,
            _: &str,
            _: &str,
            _: &[String],
        ) -> Result<bool, String> {
            Ok(self.strict_base)
        }
        fn squash_merge(&mut self, _: &str, _: u64, expected: &str) -> Result<String, String> {
            self.actions.push(format!("WRITE:squash:{expected}"));
            if self.pull.as_ref().map(|p| p.head_sha.as_str()) != Some(expected) {
                return Err("authorization: token-secret; head mismatch".into());
            }
            self.base = "dddddddd".into();
            Ok("dddddddd".into())
        }
        fn deploy_intent_exists(
            &mut self,
            _: &str,
            _: &str,
            _: &str,
            _: &str,
        ) -> Result<bool, String> {
            Ok(self.intent)
        }
        fn dispatch_deploy(
            &mut self,
            _: &str,
            workflow: &str,
            _: &str,
            _: &str,
            _: &str,
        ) -> Result<(), String> {
            self.actions.push(format!("WRITE:dispatch:{workflow}"));
            self.intent = true;
            Ok(())
        }
        fn deploy_verified(
            &mut self,
            _: &str,
            _: &str,
            intent_key: &str,
            _: &str,
        ) -> Result<bool, String> {
            self.actions.push(format!("VERIFY:{intent_key}"));
            Ok(self.verified)
        }
    }

    fn test_claim() -> ApprovedClaim {
        let files = vec![
            PublicationFile {
                path: "content/tr/article.md".into(),
                content: FileContent::Text("merhaba".into()),
            },
            PublicationFile {
                path: "public/image.bin".into(),
                content: FileContent::Bytes(vec![0, 1, 2]),
            },
        ];
        ApprovedClaim {
            repository: "owner/site".into(),
            base_branch: "main".into(),
            approved_base_sha: "aaaaaaaa".into(),
            approved_revision_hash: "bbbbbbbb".into(),
            approved_files_sha: claim_files_digest(&files),
            approved_head_sha: None,
            revision_id: "revision-1".into(),
            idempotency_key: "publication-1".into(),
            adapter_version: "astro-generic@2.0.0".into(),
            bundle_policy: PublicationBundlePolicy {
                adapter_id: "astro-generic".into(),
                manifest_path: ".blogbot/manifests/revision-1.json".into(),
                allowed_path_prefixes: vec![
                    "content/tr/article.md".into(),
                    "public/image.bin".into(),
                    ".blogbot/manifests/revision-1.json".into(),
                ],
            },
            files,
        }
    }
    fn test_config() -> PublicationConfig {
        PublicationConfig {
            required_checks: vec!["ci/test".into(), "ci/lint".into()],
            deploy_workflow: "deploy.yml".into(),
        }
    }

    #[test]
    fn base_sha_mismatch_fails_before_any_write() {
        let mut github = FakeGithub::with_base_sha("bbbbbbbb");
        let error = reconcile(&test_claim(), &test_config(), &mut github).unwrap_err();
        assert_eq!(error.code, "BASE_SHA_MISMATCH");
        assert!(github.writes().is_empty());
    }

    #[test]
    fn never_patches_or_writes_the_base_ref() {
        let mut github = FakeGithub::with_base_sha("aaaaaaaa");
        let result = reconcile(&test_claim(), &test_config(), &mut github).unwrap();
        assert_eq!(result.status, "UNKNOWN");
        assert!(github
            .actions
            .iter()
            .all(|a| !a.contains("PATCH") && !a.contains("put:main")));
    }

    #[test]
    fn existing_pull_request_is_reused_without_duplicate_branch_or_content_writes() {
        let mut github = FakeGithub::ready();
        reconcile(&test_claim(), &test_config(), &mut github).unwrap();
        assert!(github.actions.iter().all(|a| !a.contains("create-branch")
            && !a.contains("create-pr")
            && !a.contains("WRITE:put")));
    }

    #[test]
    fn retry_after_partial_branch_reuses_matching_files() {
        let claim = test_claim();
        let mut github = FakeGithub::with_base_sha("aaaaaaaa");
        github.branch = Some("aaaaaaaa".into());
        github
            .files
            .extend(claim.files.iter().map(|file| file.path.clone()));

        reconcile(&claim, &test_config(), &mut github).unwrap();

        assert!(!github
            .actions
            .iter()
            .any(|action| action.contains("WRITE:put")));
        assert_eq!(
            github
                .actions
                .iter()
                .filter(|action| action.contains("create-pr"))
                .count(),
            1
        );
    }

    #[test]
    fn pending_missing_and_failed_checks_never_merge() {
        for state in [Some(CheckState::Pending), None, Some(CheckState::Failed)] {
            let mut github = FakeGithub::ready();
            match state {
                Some(value) => {
                    github.checks.insert("ci/test".into(), value);
                }
                None => {
                    github.checks.remove("ci/test");
                }
            }
            let result = reconcile(&test_claim(), &test_config(), &mut github).unwrap();
            assert_eq!(result.stage, PublicationStage::WaitingForChecks);
            assert_eq!(result.status, "UNKNOWN");
            assert!(!github.actions.iter().any(|a| a.contains("squash")));
        }
    }

    #[test]
    fn squash_merge_occurs_only_after_exact_required_checks_and_binds_head_sha() {
        let mut github = FakeGithub::ready();
        reconcile(&test_claim(), &test_config(), &mut github).unwrap();
        assert!(github
            .actions
            .contains(&"WRITE:squash:cccccccc".to_string()));
    }

    #[test]
    fn changed_head_cannot_be_squash_merged() {
        let mut claim = test_claim();
        claim.approved_head_sha = Some("eeeeeeee".into());
        let mut github = FakeGithub::ready();

        let error = reconcile(&claim, &test_config(), &mut github).unwrap_err();

        assert_eq!(error.code, "HEAD_SHA_MISMATCH");
        assert!(!github
            .actions
            .iter()
            .any(|action| action.contains("squash")));
    }

    #[test]
    fn automatic_merge_is_refused_without_strict_current_base_protection() {
        let mut github = FakeGithub::ready();
        github.strict_base = false;
        let error = reconcile(&test_claim(), &test_config(), &mut github).unwrap_err();
        assert_eq!(error.code, "BASE_SHA_GUARANTEE_UNAVAILABLE");
        assert!(!github.actions.iter().any(|action| action.contains("squash")));
    }

    #[test]
    fn deploy_dispatch_is_an_idempotent_intent_and_never_claims_success() {
        let mut github = FakeGithub::ready();
        let first = reconcile(&test_claim(), &test_config(), &mut github).unwrap();
        github.pull = Some(PullRequest {
            number: 7,
            head_sha: "cccccccc".into(),
            merged: true,
            merge_sha: Some("dddddddd".into()),
        });
        let second = reconcile(&test_claim(), &test_config(), &mut github).unwrap();
        assert_eq!(
            github
                .actions
                .iter()
                .filter(|a| a.contains("dispatch"))
                .count(),
            1
        );
        assert_eq!(first.status, "UNKNOWN");
        assert_eq!(second.stage, PublicationStage::WaitingForDeployVerification);
        assert!((1..=300).contains(&second.retry_after_seconds));
    }

    #[test]
    fn merged_pull_request_rejects_unrelated_base_movement_before_deploy() {
        let mut github = FakeGithub::ready();
        github.pull = Some(PullRequest {
            number: 7,
            head_sha: "cccccccc".into(),
            merged: true,
            merge_sha: Some("dddddddd".into()),
        });
        github.base = "eeeeeeee".into();

        let error = reconcile(&test_claim(), &test_config(), &mut github).unwrap_err();

        assert_eq!(error.code, "MERGED_BASE_SHA_MISMATCH");
        assert!(!github
            .actions
            .iter()
            .any(|action| action.contains("dispatch")));
    }

    #[test]
    fn verified_deployment_is_the_only_terminal_success() {
        let mut github = FakeGithub::ready();
        github.pull = Some(PullRequest {
            number: 7,
            head_sha: "cccccccc".into(),
            merged: true,
            merge_sha: Some("dddddddd".into()),
        });
        github.base = "dddddddd".into();
        github.intent = true;
        github.verified = true;

        let result = reconcile(&test_claim(), &test_config(), &mut github).unwrap();

        assert_eq!(result.status, "SUCCEEDED");
        assert_eq!(result.stage, PublicationStage::WaitingForDeployVerification);
        assert_eq!(result.retry_after_seconds, 0);
        assert!(github
            .actions
            .iter()
            .any(|action| action.starts_with("VERIFY:")));
    }

    #[test]
    fn configuration_and_claim_validation_fail_closed() {
        let mut github = FakeGithub::with_base_sha("aaaaaaaa");
        let mut config = test_config();
        config.required_checks.clear();
        assert_eq!(
            reconcile(&test_claim(), &config, &mut github)
                .unwrap_err()
                .code,
            "INVALID_CONFIG"
        );
        config = test_config();
        config.deploy_workflow = "../deploy.yml".into();
        assert_eq!(
            reconcile(&test_claim(), &config, &mut github)
                .unwrap_err()
                .code,
            "INVALID_CONFIG"
        );
        let mut claim = test_claim();
        claim.files[0].path = "../secret".into();
        assert_eq!(
            reconcile(&claim, &test_config(), &mut github)
                .unwrap_err()
                .code,
            "INVALID_FILES"
        );
        let mut claim = test_claim();
        claim.approved_files_sha = "ffffffff".into();
        assert_eq!(
            reconcile(&claim, &test_config(), &mut github)
                .unwrap_err()
                .code,
            "FILES_HASH_MISMATCH"
        );
    }

    #[test]
    fn remote_failures_and_results_never_expose_tokens() {
        let redaction_canary = ["ghp", "SUPER", "SECRET", "TOKEN"].join("_");
        let mut github = FakeGithub::with_base_sha("aaaaaaaa");
        github.failure = Some(format!("authorization: Bearer {redaction_canary}"));
        let error = reconcile(&test_claim(), &test_config(), &mut github).unwrap_err();
        assert!(!error.safe_message.contains(&redaction_canary));
        assert!(!format!("{error:?}").contains(&redaction_canary));
        assert!(!deterministic_branch(&test_claim().idempotency_key).contains(&redaction_canary));
    }
}
