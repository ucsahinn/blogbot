use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

const MAX_FILES: usize = 256;
pub(crate) const MAX_FILE_BYTES: usize = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 50 * 1024 * 1024;
pub(crate) const RETRY_AFTER_SECONDS: u32 = 30;

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

    fn from_remote(operation: &str, error: String) -> Self {
        if error == "GITHUB_REAUTHORIZATION_REQUIRED" {
            return Self {
                code: "GITHUB_REAUTHORIZATION_REQUIRED",
                safe_message: "GitHub authorization must be renewed before publication".into(),
            };
        }
        Self::remote(operation)
    }
}

pub trait GithubRestPort {
    fn base_sha(&mut self, repository: &str, base_branch: &str) -> Result<String, String>;
    fn find_branch(&mut self, repository: &str, branch: &str) -> Result<Option<String>, String>;
    /// Whether the base branch still contains a commit.
    ///
    /// After a merge the base tip legitimately keeps moving, so equality with
    /// the merge commit is the wrong test. A history rewrite can remove the
    /// merge commit entirely; a normal revert preserves its ancestry, so
    /// callers must also verify approved files against the current base ref.
    fn base_contains_commit(
        &mut self,
        repository: &str,
        base_branch: &str,
        commit_sha: &str,
    ) -> Result<bool, String>;
    /// Paths the publication branch changes relative to the approved base.
    ///
    /// Presence of the approved files is not the same as absence of anything
    /// else. Without this, a branch carrying extra commits could be merged as
    /// long as the approved files happened to match, so content that no human
    /// approved would reach the site.
    fn changed_paths(
        &mut self,
        repository: &str,
        base_sha: &str,
        head: &str,
    ) -> Result<Vec<String>, String>;
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
    /// Removes only the three refs owned by a terminal publication.
    /// Implementations must verify each current SHA before deletion and treat
    /// an already absent ref as success so interrupted cleanup can reconcile.
    fn cleanup_publication_refs(
        &mut self,
        repository: &str,
        branch: &str,
        expected_head_sha: &str,
        intent_key: &str,
        merge_sha: &str,
    ) -> Result<(), String>;
}

/// Rejects a publication branch that changes anything the approval did not cover.
fn assert_only_approved_paths_changed(
    claim: &ApprovedClaim,
    github: &mut impl GithubRestPort,
    head: &str,
) -> Result<(), PublicationError> {
    let approved: BTreeSet<&str> = claim.files.iter().map(|file| file.path.as_str()).collect();
    let changed = github
        .changed_paths(&claim.repository, &claim.approved_base_sha, head)
        .map_err(|error| PublicationError::from_remote("branch comparison", error))?;
    if changed.iter().any(|path| !approved.contains(path.as_str())) {
        return Err(PublicationError::validation(
            "REMOTE_STATE_INVALID",
            "publication branch changes files outside the approved bundle",
        ));
    }
    Ok(())
}

pub fn reconcile(
    claim: &ApprovedClaim,
    config: &PublicationConfig,
    github: &mut impl GithubRestPort,
) -> Result<ReconcileResult, PublicationError> {
    validate(claim, config)?;
    let branch = deterministic_branch(&claim.idempotency_key);
    let base_sha = github
        .base_sha(&claim.repository, &claim.base_branch)
        .map_err(|error| PublicationError::from_remote("base lookup", error))?;
    let mut pull = github
        .find_pull_request(&claim.repository, &branch, &claim.base_branch)
        .map_err(|error| PublicationError::from_remote("pull request lookup", error))?;
    // Once GitHub reports the pull request merged, the base tip can legitimately
    // keep moving. The merged path below therefore verifies both ancestry and
    // current approved file content instead of requiring tip equality.
    let merged = pull.as_ref().is_some_and(|pull| pull.merged);
    if !merged && base_sha != claim.approved_base_sha {
        return Err(PublicationError::validation(
            "BASE_SHA_MISMATCH",
            "approved base SHA no longer matches",
        ));
    }
    let mut created_pull = false;
    if pull.is_none() {
        let branch_sha = github
            .find_branch(&claim.repository, &branch)
            .map_err(|error| PublicationError::from_remote("branch lookup", error))?;
        if let Some(existing) = branch_sha {
            // A pass interrupted between the first content write and the pull
            // request creation leaves the deterministic branch created and
            // already advanced past the approved base, so a plain head
            // comparison rejected the exact state recovery reproduces forever.
            // Accept that head only when every approved file is already present
            // exactly as approved; anything else is still remote drift.
            if existing != claim.approved_base_sha {
                // Accept the recovered head only when the branch changes
                // nothing beyond the approved bundle. Checking that the
                // approved files are merely present would let unrelated
                // commits ride along into the merge.
                assert_only_approved_paths_changed(claim, github, &existing)?;
            }
        } else {
            github
                .create_branch(&claim.repository, &branch, &claim.approved_base_sha)
                .map_err(|error| PublicationError::from_remote("branch creation", error))?;
        }
        for file in &claim.files {
            let matches = github
                .file_matches(&claim.repository, &branch, file)
                .map_err(|error| PublicationError::from_remote("content lookup", error))?;
            if !matches {
                github
                    .put_file(&claim.repository, &branch, file)
                    .map_err(|error| PublicationError::from_remote("content write", error))?;
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
                .map_err(|error| PublicationError::from_remote("pull request creation", error))?,
        );
        created_pull = true;
    }
    let pull = pull.expect("pull request is established");
    let result_ref = format!("pr:{}:{}", pull.number, pull.head_sha);
    // A pull request head is remote state, not part of the original approval.
    // Persist it through the outbox result before checks or merge can run. This
    // also covers recovery after a crash between PR creation and completion:
    // an existing open PR without a persisted head remains waiting.
    if !pull.merged && (created_pull || claim.approved_head_sha.is_none()) {
        return Ok(waiting(
            PublicationStage::WaitingForChecks,
            result_ref,
            None,
        ));
    }
    if let Some(approved_head) = &claim.approved_head_sha {
        if &pull.head_sha != approved_head {
            return Err(PublicationError::validation(
                "HEAD_SHA_MISMATCH",
                "pull request head no longer matches the approved claim",
            ));
        }
    }
    let content_reference = if pull.merged {
        pull.merge_sha.as_deref().ok_or_else(|| {
            PublicationError::validation(
                "REMOTE_STATE_INVALID",
                "merged pull request has no merge SHA",
            )
        })?
    } else {
        pull.head_sha.as_str()
    };
    for file in &claim.files {
        let matches = github
            .file_matches(&claim.repository, content_reference, file)
            .map_err(|error| PublicationError::from_remote("content revalidation", error))?;
        if !matches {
            return Err(PublicationError::validation(
                "REMOTE_STATE_INVALID",
                "publication branch no longer matches the approved files",
            ));
        }
    }
    let checks = github
        .checks(&claim.repository, &pull.head_sha)
        .map_err(|error| PublicationError::from_remote("check lookup", error))?;
    let mut failed = Vec::new();
    let mut pending = false;
    for required in &config.required_checks {
        match checks.get(required) {
            Some(CheckState::Success) => {}
            Some(CheckState::Failed) => failed.push(required.as_str()),
            Some(CheckState::Pending) | None => pending = true,
        }
    }
    if !failed.is_empty() {
        let listed = failed
            .iter()
            .take(8)
            .copied()
            .collect::<Vec<_>>()
            .join(", ");
        let suffix = if failed.len() > 8 { ", ..." } else { "" };
        return Err(PublicationError::validation(
            "REQUIRED_CHECK_FAILED",
            &format!("required GitHub checks failed: {listed}{suffix}"),
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
        // Auto-delete-head repositories remove the topic branch immediately
        // after merge. The merge commit is immutable and survives that cleanup,
        // so both exact content and the approved path set are revalidated there.
        assert_only_approved_paths_changed(claim, github, &merge_sha)?;
        // The base tip legitimately advances after the merge (the next
        // publication, a human push, the deploy workflow's own commit), so
        // requiring it to still equal this merge commit is too strict. Ancestry
        // detects a force-push that removed the merge; exact file checks on the
        // current base below separately detect an ordinary revert.
        let still_published = github
            .base_contains_commit(&claim.repository, &claim.base_branch, &merge_sha)
            .map_err(|error| PublicationError::from_remote("base history verification", error))?;
        if !still_published {
            return Err(PublicationError::validation(
                "MERGED_BASE_SHA_MISMATCH",
                "merged publication is no longer part of the base branch history",
            ));
        }
        for file in &claim.files {
            let matches = github
                .file_matches(&claim.repository, &claim.base_branch, file)
                .map_err(|error| {
                    PublicationError::from_remote("base content verification", error)
                })?;
            if !matches {
                return Err(PublicationError::validation(
                    "MERGED_BASE_CONTENT_MISMATCH",
                    "approved files no longer match the current base branch",
                ));
            }
        }
        merge_sha
    } else {
        let current_base = github
            .base_sha(&claim.repository, &claim.base_branch)
            .map_err(|error| PublicationError::from_remote("pre-merge base verification", error))?;
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
            .map_err(|error| PublicationError::from_remote("branch protection lookup", error))?;
        if !strict_base {
            return Err(PublicationError::validation(
                "BASE_SHA_GUARANTEE_UNAVAILABLE",
                "automatic merge requires strict up-to-date required checks",
            ));
        }
        // Presence of the approved files was already revalidated above; this
        // also proves the branch changes nothing else before it is merged.
        assert_only_approved_paths_changed(claim, github, &pull.head_sha)?;
        // GitHub's strict required-check protection then rejects a merge whose
        // checks were not evaluated against the current target base, while the
        // endpoint atomically binds the approved PR head SHA.
        github
            .squash_merge(&claim.repository, pull.number, &pull.head_sha)
            .map_err(|error| PublicationError::from_remote("squash merge", error))?
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
        .map_err(|error| PublicationError::from_remote("deploy intent lookup", error))?;
    if !dispatched {
        github
            .dispatch_deploy(
                &claim.repository,
                &config.deploy_workflow,
                &claim.base_branch,
                &intent_key,
                &merge_sha,
            )
            .map_err(|error| PublicationError::from_remote("workflow dispatch", error))?;
    }
    let verified = github
        .deploy_verified(
            &claim.repository,
            &config.deploy_workflow,
            &intent_key,
            &merge_sha,
        )
        .map_err(|error| PublicationError::from_remote("deployment verification", error))?;
    if !verified {
        return Ok(waiting(
            PublicationStage::WaitingForDeployVerification,
            result_ref,
            None,
        ));
    }
    github
        .cleanup_publication_refs(
            &claim.repository,
            &branch,
            &pull.head_sha,
            &intent_key,
            &merge_sha,
        )
        .map_err(|error| {
            if error == "GITHUB_PUBLICATION_REF_CONFLICT" {
                PublicationError::validation(
                    "REMOTE_STATE_INVALID",
                    "publication cleanup ref no longer matches the approved commit",
                )
            } else {
                PublicationError::from_remote("publication ref cleanup", error)
            }
        })?;
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
    crate::secure_store::valid_github_repository_name(value)
}
fn safe_branch(value: &str) -> bool {
    crate::secure_store::valid_github_branch_name(value)
}
fn safe_sha(value: &str) -> bool {
    (7..=64).contains(&value.len()) && value.chars().all(|c| c.is_ascii_hexdigit())
}
fn safe_workflow(value: &str) -> bool {
    crate::secure_store::valid_github_workflow_name(value)
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
        /// `None` means "exactly the approved bundle"; the default honest case.
        changed: Option<Vec<String>>,
        /// Commits removed from base ancestry by a force-push/history rewrite.
        commits_missing_from_base_history: BTreeSet<String>,
        /// Exact reference/path pairs whose content no longer matches approval.
        mismatched_files: BTreeSet<(String, String)>,
        file_match_refs: Vec<String>,
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
        fn base_contains_commit(
            &mut self,
            _: &str,
            _: &str,
            commit_sha: &str,
        ) -> Result<bool, String> {
            Ok(!self.commits_missing_from_base_history.contains(commit_sha))
        }
        fn changed_paths(&mut self, _: &str, _: &str, _: &str) -> Result<Vec<String>, String> {
            Ok(self
                .changed
                .clone()
                .unwrap_or_else(|| self.files.iter().cloned().collect()))
        }
        fn file_matches(
            &mut self,
            _: &str,
            reference: &str,
            file: &PublicationFile,
        ) -> Result<bool, String> {
            self.file_match_refs.push(reference.to_string());
            Ok(self.files.contains(&file.path)
                && !self
                    .mismatched_files
                    .contains(&(reference.to_string(), file.path.clone())))
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
        fn cleanup_publication_refs(
            &mut self,
            _: &str,
            branch: &str,
            expected_head_sha: &str,
            intent_key: &str,
            merge_sha: &str,
        ) -> Result<(), String> {
            self.actions.push(format!(
                "WRITE:cleanup:{branch}:{intent_key}:{expected_head_sha}:{merge_sha}"
            ));
            Ok(())
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
            approved_head_sha: Some("cccccccc".into()),
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
    fn publication_repository_uses_the_shared_dot_segment_contract() {
        let mut valid = test_claim();
        valid.repository = "owner/.github".into();
        assert!(validate(&valid, &test_config()).is_ok());

        for repository in ["owner/.", "owner/..", "../site", "owner/site/extra"] {
            let mut invalid = test_claim();
            invalid.repository = repository.into();
            let error = validate(&invalid, &test_config()).unwrap_err();
            assert_eq!(error.code, "INVALID_CLAIM", "{repository}");
        }
    }

    #[test]
    fn publication_branch_uses_the_shared_contract() {
        let mut valid = test_claim();
        valid.base_branch = "release/v1.2.3".into();
        assert!(validate(&valid, &test_config()).is_ok());

        for branch in [
            "/main",
            "main/",
            "main//next",
            "main..next",
            "main:next",
            ".hidden",
            "feature/.hidden",
            "feature.lock",
            "feature/x.lock",
            "feature.",
            "-main",
        ] {
            let mut invalid = test_claim();
            invalid.base_branch = branch.into();
            let error = validate(&invalid, &test_config()).unwrap_err();
            assert_eq!(error.code, "INVALID_CLAIM", "{branch}");
        }
    }

    #[test]
    fn publication_workflow_uses_the_shared_contract() {
        for workflow in ["deploy.yml", "release_1.yaml"] {
            let mut valid = test_config();
            valid.deploy_workflow = workflow.into();
            assert!(validate(&test_claim(), &valid).is_ok(), "{workflow}");
        }

        for workflow in [
            format!("{}.yml", "w".repeat(97)),
            "a..yml".to_string(),
            ".yml".to_string(),
            "deploy.txt".to_string(),
            "nested/deploy.yml".to_string(),
        ] {
            let mut invalid = test_config();
            invalid.deploy_workflow = workflow.clone();
            let error = validate(&test_claim(), &invalid).unwrap_err();
            assert_eq!(error.code, "INVALID_CONFIG", "{workflow}");
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
    fn pending_and_missing_checks_never_merge() {
        for state in [Some(CheckState::Pending), None] {
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
    fn a_completed_failed_required_check_is_terminal_and_actionable() {
        let mut github = FakeGithub::ready();
        github.checks.insert("ci/test".into(), CheckState::Failed);

        let error = reconcile(&test_claim(), &test_config(), &mut github).unwrap_err();

        assert_eq!(error.code, "REQUIRED_CHECK_FAILED");
        assert!(error.safe_message.contains("ci/test"));
        assert!(!github
            .actions
            .iter()
            .any(|action| action.contains("squash")));
    }

    #[test]
    fn a_new_pull_request_requires_a_durable_head_binding_roundtrip() {
        let mut claim = test_claim();
        claim.approved_head_sha = None;
        let mut github = FakeGithub::with_base_sha("aaaaaaaa");
        github.checks.insert("ci/test".into(), CheckState::Success);
        github.checks.insert("ci/lint".into(), CheckState::Success);
        github.strict_base = true;

        let first = reconcile(&claim, &test_config(), &mut github).unwrap();

        assert_eq!(first.status, "UNKNOWN");
        assert_eq!(first.result_ref, "pr:7:cccccccc");
        assert!(!github
            .actions
            .iter()
            .any(|action| action.contains("squash")));

        // The engine persists the result ref before the next claim. If another
        // commit lands on the topic branch in between, that next pass must fail
        // against the persisted approved head rather than checking or merging it.
        let mut rebound = claim;
        rebound.approved_head_sha = Some("cccccccc".into());
        github.pull = Some(PullRequest {
            number: 7,
            head_sha: "eeeeeeee".into(),
            merged: false,
            merge_sha: None,
        });
        let error = reconcile(&rebound, &test_config(), &mut github).unwrap_err();
        assert_eq!(error.code, "HEAD_SHA_MISMATCH");
        assert!(!github
            .actions
            .iter()
            .any(|action| action == "WRITE:squash:eeeeeeee"));
    }

    #[test]
    fn a_merged_pull_with_an_auto_deleted_head_is_revalidated_at_merge_and_base() {
        let mut github = FakeGithub::ready();
        github.pull = Some(PullRequest {
            number: 7,
            head_sha: "cccccccc".into(),
            merged: true,
            merge_sha: Some("dddddddd".into()),
        });
        github.branch = None;

        reconcile(&test_claim(), &test_config(), &mut github).unwrap();

        assert_eq!(
            github.file_match_refs,
            vec![
                "dddddddd".to_string(),
                "dddddddd".to_string(),
                "main".to_string(),
                "main".to_string(),
            ]
        );
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
        assert!(!github
            .actions
            .iter()
            .any(|action| action.contains("squash")));
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
    fn an_unapproved_change_on_the_branch_is_never_merged() {
        // Revalidating that the approved files are present says nothing about
        // what else the branch carries. Without comparing the change set, a
        // commit no human approved rode along into the merge and onto the site.
        let mut github = FakeGithub::ready();
        github.changed = Some(vec![
            "content/tr/article.md".into(),
            ".github/workflows/deploy.yml".into(),
        ]);

        let error = reconcile(&test_claim(), &test_config(), &mut github).unwrap_err();

        assert_eq!(error.code, "REMOTE_STATE_INVALID");
        assert!(!github
            .actions
            .iter()
            .any(|action| action.starts_with("WRITE:squash")));
    }

    #[test]
    fn a_branch_changing_only_approved_files_still_merges() {
        let mut github = FakeGithub::ready();
        github.changed = Some(vec!["content/tr/article.md".into()]);

        let result = reconcile(&test_claim(), &test_config(), &mut github)
            .expect("an approved-only change set must be publishable");

        assert_ne!(result.status, "FAILED");
        assert!(github
            .actions
            .iter()
            .any(|action| action.starts_with("WRITE:squash")));
    }

    #[test]
    fn an_interrupted_pass_recovers_only_when_the_branch_matches_the_approval() {
        // A pass interrupted between the first content write and the pull
        // request creation leaves the branch created and already advanced past
        // the approved base. That exact state must be recoverable, but only
        // when nothing outside the approved bundle changed.
        let mut recoverable = FakeGithub::ready();
        recoverable.pull = None;
        recoverable.branch = Some("ffffffff".into());
        recoverable.changed = Some(vec!["content/tr/article.md".into()]);
        assert!(reconcile(&test_claim(), &test_config(), &mut recoverable).is_ok());

        let mut drifted = FakeGithub::ready();
        drifted.pull = None;
        drifted.branch = Some("ffffffff".into());
        drifted.changed = Some(vec!["content/tr/article.md".into(), "src/config.ts".into()]);
        let error = reconcile(&test_claim(), &test_config(), &mut drifted).unwrap_err();
        assert_eq!(error.code, "REMOTE_STATE_INVALID");
    }

    #[test]
    fn a_merged_publication_survives_later_commits_on_the_base() {
        // A human push, the next publication or the deploy workflow own
        // commit all advance the base after the merge. Demanding the tip still
        // equal this merge commit failed an already published revision.
        let mut github = FakeGithub::ready();
        github.pull = Some(PullRequest {
            number: 7,
            head_sha: "cccccccc".into(),
            merged: true,
            merge_sha: Some("dddddddd".into()),
        });
        github.base = "eeeeeeee".into();

        let result = reconcile(&test_claim(), &test_config(), &mut github)
            .expect("a merged publication must keep reconciling");

        assert!(github
            .actions
            .iter()
            .any(|action| action.contains("dispatch")));
        assert_ne!(result.status, "FAILED");
    }

    #[test]
    fn a_history_rewrite_that_removes_the_merge_cannot_deploy() {
        // A force-push can remove the merge from base ancestry entirely, so
        // deploying the current tip would ship something other than approval.
        let mut github = FakeGithub::ready();
        github.pull = Some(PullRequest {
            number: 7,
            head_sha: "cccccccc".into(),
            merged: true,
            merge_sha: Some("dddddddd".into()),
        });
        github.base = "eeeeeeee".into();
        github
            .commits_missing_from_base_history
            .insert("dddddddd".into());

        let error = reconcile(&test_claim(), &test_config(), &mut github).unwrap_err();

        assert_eq!(error.code, "MERGED_BASE_SHA_MISMATCH");
        assert!(!github
            .actions
            .iter()
            .any(|action| action.contains("dispatch")));
    }

    #[test]
    fn a_normal_revert_that_keeps_merge_ancestry_cannot_deploy() {
        let claim = test_claim();
        let mut github = FakeGithub::ready();
        github.pull = Some(PullRequest {
            number: 7,
            head_sha: "cccccccc".into(),
            merged: true,
            merge_sha: Some("dddddddd".into()),
        });
        github.base = "eeeeeeee".into();
        github
            .mismatched_files
            .insert((claim.base_branch.clone(), claim.files[0].path.clone()));

        let error = reconcile(&claim, &test_config(), &mut github).unwrap_err();
        assert_eq!(error.code, "MERGED_BASE_CONTENT_MISMATCH");
        assert!(error.safe_message.contains("approved files"));
        assert!(error.safe_message.contains("base branch"));
        assert!(github.writes().is_empty());
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
    fn terminal_success_cleans_only_its_bounded_publication_refs() {
        let mut github = FakeGithub::ready();
        github.pull = Some(PullRequest {
            number: 7,
            head_sha: "cccccccc".into(),
            merged: true,
            merge_sha: Some("dddddddd".into()),
        });
        github.base = "dddddddd".into();
        github.intent = true;

        let waiting_result = reconcile(&test_claim(), &test_config(), &mut github).unwrap();
        assert_eq!(waiting_result.status, "UNKNOWN");
        assert!(!github
            .actions
            .iter()
            .any(|action| action.starts_with("WRITE:cleanup:")));

        github.verified = true;
        let success = reconcile(&test_claim(), &test_config(), &mut github).unwrap();
        assert_eq!(success.status, "SUCCEEDED");
        let cleanup = github
            .actions
            .iter()
            .filter(|action| action.starts_with("WRITE:cleanup:"))
            .collect::<Vec<_>>();
        assert_eq!(cleanup.len(), 1);
        assert!(cleanup[0].contains("cccccccc:dddddddd"));
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

    #[test]
    fn github_authorization_failures_survive_reconcile_as_a_stable_code() {
        let mut github = FakeGithub::with_base_sha("aaaaaaaa");
        github.failure = Some("GITHUB_REAUTHORIZATION_REQUIRED".into());
        let error = reconcile(&test_claim(), &test_config(), &mut github).unwrap_err();
        assert_eq!(error.code, "GITHUB_REAUTHORIZATION_REQUIRED");
        assert!(!error.safe_message.contains("token"));
    }
}
