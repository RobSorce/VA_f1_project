"""The Pages workflow deploys the demo only after the tests pass.

.github/workflows/deploy.yml built and deployed the demo without running a
test. It now has a frontend test job (npm test) and a backend test job
(pytest, PyTorch from its CPU wheel index), both with their downloads
cached and a time limit, and the deploy job needs both and the build.
"""
import pytest

from conftest import BACKEND

yaml = pytest.importorskip("yaml")  # PyYAML comes with uvicorn[standard]

WORKFLOW = BACKEND.parent / ".github" / "workflows" / "deploy.yml"


@pytest.fixture(scope="module")
def jobs():
    return yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))["jobs"]


def runs(job):
    return "\n".join(step.get("run", "") for step in job["steps"])


def step_with(job, uses):
    return next(step for step in job["steps"] if step.get("uses", "").startswith(uses))


def test_the_deploy_needs_both_test_jobs_and_the_build(jobs):
    assert set(jobs["deploy"]["needs"]) == {"test-frontend", "test-backend", "build"}


def test_the_frontend_job_runs_vitest_with_the_npm_cache(jobs):
    job = jobs["test-frontend"]
    assert "npm ci" in runs(job) and "npm test" in runs(job)
    node = step_with(job, "actions/setup-node")["with"]
    assert node["cache"] == "npm" and node["cache-dependency-path"] == "frontend/package-lock.json"


def test_the_backend_job_runs_pytest_with_cpu_torch_and_the_pip_cache(jobs):
    job = jobs["test-backend"]
    commands = runs(job)
    torch_line = next(line for line in commands.splitlines() if "install torch" in line)
    assert "--index-url https://download.pytorch.org/whl/cpu" in torch_line
    # torch comes first, so requirements.txt finds it installed (no CUDA build)
    assert commands.index("install torch") < commands.index("-r backend/requirements.txt")
    assert "python -m pytest" in commands
    python = step_with(job, "actions/setup-python")["with"]
    assert python["cache"] == "pip" and python["cache-dependency-path"] == "backend/requirements.txt"


def test_every_job_has_a_time_limit_and_the_tests_only_read(jobs):
    for name in ("test-frontend", "test-backend", "build"):
        assert 0 < jobs[name]["timeout-minutes"] <= 15, name
    for name in ("test-frontend", "test-backend"):
        assert jobs[name]["permissions"] == {"contents": "read"}, name
